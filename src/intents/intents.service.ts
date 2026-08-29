import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Intent, IntentAuditEntry, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";
import { AppConfig } from "../config/configuration";
import { CHAIN_DEADLINE_DEFAULTS, DEFAULT_DEADLINE_SECONDS } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";

const STORE_SIZE_LOG_INTERVAL_MS = 60_000;

/**
 * Orchestration layer for intents.
 *
 * Business logic (ID generation, default state, deadline defaulting) lives
 * here. All persistence is delegated to the internal in-memory Map.
 * Once issue #36 lands, this will delegate to an injected IIntentsRepository
 * so the storage adapter can be swapped without touching this service.
 */
@Injectable()
export class IntentsService implements OnModuleDestroy {
  private readonly logger = new Logger(IntentsService.name);
  private readonly intents = new Map<string, Intent>();
  private readonly idempotencyCache = new Map<string, { intentId: string; expiresAt: number }>();

  /**
   * In-memory audit log used as a fast read path and fallback when the DB is
   * unavailable. The canonical source of truth is the intent_audit_log table
   * (issue #217 / #62). Writes are fire-and-forget against PrismaService so a
   * DB write failure never blocks or rolls back the underlying state transition.
   */
  private readonly auditLog = new Map<string, IntentAuditEntry[]>();

  private readonly sizeLogTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly stellarTxService: StellarTxService,
    private readonly prisma: PrismaService,
  ) {
    this.seed();
    this.sizeLogTimer = setInterval(() => this.logStoreSize(), STORE_SIZE_LOG_INTERVAL_MS);
    // Allow the process to exit even if the timer is still active.
    this.sizeLogTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sizeLogTimer);
  }

  /** Logs the current intent map size so unbounded growth is observable. */
  logStoreSize(): void {
    this.logger.log(`[store-monitor] intents map size: ${this.intents.size}`);
  }

  async create(
    data: Omit<Intent, "intentId" | "createdAt" | "state">,
    idempotencyKey?: string,
  ): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000);

    if (idempotencyKey) {
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached && cached.expiresAt > now) {
        const cachedIntent = this.intents.get(cached.intentId);
        if (cachedIntent) {
          return cachedIntent;
        }
      }
      this.idempotencyCache.delete(idempotencyKey);
    }

    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: data.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[data.srcChain] ?? DEFAULT_DEADLINE_SECONDS),
    };

    if (this.configService.get("onchainIntentsEnabled", { infer: true })) {
      await this.registerOnChain(intent);
    }

    this.intents.set(intent.intentId, intent);

    if (idempotencyKey) {
      const ttl = 86400; // 24 hours
      this.idempotencyCache.set(idempotencyKey, {
        intentId: intent.intentId,
        expiresAt: now + ttl,
      });
    }

    return intent;
  }

  /**
   * Registers `intent` with the settlement contract. Only called when
   * ONCHAIN_INTENTS_ENABLED is on; while that flag is off, create() stays
   * fully in-memory (the rollout fallback).
   */
  private async registerOnChain(intent: Intent): Promise<void> {
    const contractId = this.configService.get("stellar.settlementContractId", { infer: true });
    if (!contractId) {
      throw new ServiceUnavailableException(
        "On-chain intent registration is enabled but SETTLEMENT_CONTRACT_ID is not configured",
      );
    }

    try {
      const result = await this.stellarTxService.invokeContract({
        contractId,
        method: "create_intent",
        args: this.buildCreateIntentArgs(intent),
      });
      this.logger.log(`Registered intent ${intent.intentId} on-chain (tx ${result.hash})`);
    } catch (err) {
      this.logger.error(
        `Failed to register intent ${intent.intentId} on-chain: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        "Failed to register intent with the settlement contract",
      );
    }
  }

  private buildCreateIntentArgs(intent: Intent): xdr.ScVal[] {
    return [
      nativeToScVal(intent.intentId, { type: "string" }),
      new Address(intent.user).toScVal(),
      nativeToScVal(intent.srcChain, { type: "symbol" }),
      nativeToScVal(intent.srcToken.address, { type: "string" }),
      nativeToScVal(BigInt(intent.srcAmount), { type: "i128" }),
      new Address(intent.dstToken.contract).toScVal(),
      nativeToScVal(BigInt(intent.minDstAmount), { type: "i128" }),
      nativeToScVal(intent.deadline, { type: "u64" }),
    ];
  }

  get(id: string): Intent | undefined {
    return this.intents.get(id);
  }

  getAll(): Intent[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getByState(state: IntentState): Intent[] {
    return this.getAll().filter((i) => i.state === state);
  }

  getByUser(user: string): Intent[] {
    return this.getAll().filter((i) => i.user.toLowerCase() === user.toLowerCase());
  }

  getAcceptedCountBySolver(solver: string): number {
    return this.getAll().filter((i) => i.state === "accepted" && i.solver === solver).length;
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.intents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.intents.set(id, updated);
    return updated;
  }

  /**
   * Atomically accept an intent only if it is currently "open".
   * Mirrors the DB pattern:
   *   UPDATE intents SET state='accepted' WHERE id=$1 AND state='open' RETURNING *
   * Returns null when the intent is not found or is not in the "open" state (already taken).
   */
  acceptIfOpen(id: string, solver: string): Intent | null {
    const existing = this.intents.get(id);
    if (!existing || existing.state !== "open") return null;

    const now = Math.floor(Date.now() / 1000);
    const updated: Intent = {
      ...existing,
      state: "accepted",
      solver,
      deadline: now + 300,
    };
    this.intents.set(id, updated);
    return updated;
  }

  /**
   * Atomically fill an intent only if it is currently "accepted" by the given solver.
   * Mirrors the DB pattern:
   *   UPDATE intents SET state='filled', ... WHERE id=$1 AND state='accepted' AND solver=$2 RETURNING *
   * Returns null when the intent is not found, not accepted, or assigned to a different solver.
   */
  fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
  ): Intent | null {
    const existing = this.intents.get(id);
    if (!existing || existing.state !== "accepted" || existing.solver !== solver) return null;

    const updated: Intent = { ...existing, ...patch, state: "filled" };
    this.intents.set(id, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Audit trail (issue #217 / #62)
  // ---------------------------------------------------------------------------

  /**
   * Append a new audit entry for the given intent.
   *
   * Writes to both the in-memory log (fast read path / restart fallback) and
   * the persistent `intent_audit_log` table via PrismaService.
   *
   * Per issue #217: the DB write is non-blocking relative to the state
   * transition — a write failure is logged loudly but never rolls back or
   * blocks the caller.
   */
  appendAuditEntry(
    intentId: string,
    toState: IntentState,
    actor: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: IntentAuditEntry = {
      timestamp: new Date().toISOString(),
      toState,
      actor,
      reason,
      ...(metadata ? { metadata } : {}),
    };

    // 1. In-memory write (synchronous, always succeeds)
    const entries = this.auditLog.get(intentId) ?? [];
    entries.push(entry);
    this.auditLog.set(intentId, entries);

    // 2. Persistent DB write (fire-and-forget, failures are logged loudly)
    // NOTE: intentAuditLog is added to the Prisma client by the migration in
    // prisma/migrations/20260828000002_intent_audit_log/migration.sql.
    // The type assertion is needed until `npm run db:generate` runs in CI
    // against the updated schema.prisma.
    (this.prisma as unknown as {
      intentAuditLog: {
        create: (args: {
          data: {
            intentId: string;
            toState: string;
            actor: string;
            reason: string;
            metadata?: Record<string, unknown>;
            timestamp: Date;
          };
        }) => Promise<unknown>;
      };
    }).intentAuditLog
      .create({
        data: {
          intentId,
          toState,
          actor,
          reason,
          metadata: metadata ?? undefined,
          timestamp: new Date(entry.timestamp),
        },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `[audit] FAILED to persist audit entry for intent ${intentId} ` +
            `(toState=${toState}, actor=${actor}): ${(err as Error).message}`,
          (err as Error).stack,
        );
      });
  }

  /**
   * Return the full audit trail for a given intent, oldest-first.
   *
   * Reads from the in-memory log as the fast path. Once the in-memory store is
   * replaced with a real DB (issue #36), this should read directly from the
   * `intent_audit_log` table ordered by timestamp ASC.
   *
   * Returns an empty array if the intent has no recorded transitions.
   */
  getAuditLog(intentId: string): IntentAuditEntry[] {
    return this.auditLog.get(intentId) ?? [];
  }

  // ---------------------------------------------------------------------------

  private seed() {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.intents.set(intent.intentId, intent);
    }
  }
}
