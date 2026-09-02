import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Intent, IntentAuditEntry, IntentState } from "./intents.types";
import { INTENTS_REPOSITORY, IIntentsRepository } from "./intents.repository";
import { AppConfig } from "../config/configuration";
import {
  CHAIN_DEADLINE_DEFAULTS,
  DEFAULT_DEADLINE_SECONDS,
  CHAIN_FILL_WINDOW_DEFAULTS,
  DEFAULT_FILL_WINDOW_SECONDS,
} from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { INTENTS_REPOSITORY, IIntentsRepository } from "./intents.repository";

const STORE_SIZE_LOG_INTERVAL_MS = 60_000;
const TERMINAL_STATES: IntentState[] = ["filled", "cancelled", "expired", "slashed"];

/** How long a completed idempotency-key result stays replayable. */
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

/**
 * Maximum number of simultaneously open (state = "open" | "accepted") intents
 * allowed per user address.
 *
 * Rationale: the per-user rate limit (UserThrottlerGuard) bounds the *rate* of
 * creation but not the standing *count* — a user could steadily accumulate
 * thousands of open intents over time, which is exactly the scenario the
 * on-call runbook flags as a sweeper-performance risk.  This constant is the
 * authoritative cap; it is enforced in IntentsController.create() before the
 * intent is persisted.
 *
 * Kept as a named constant (rather than a config value) so the cap is visible
 * at the call site and testable without ConfigService.  Raise or lower it with
 * a code change + review rather than a silent env-var override.
 */
export const MAX_OPEN_INTENTS_PER_USER = 50;

/**
 * Orchestration layer for intents.
 *
 * Business logic (ID generation, default state, deadline defaulting,
 * idempotency cache, audit log) lives here. All persistence is delegated
 * to the injected IIntentsRepository so the storage adapter can be swapped
 * (in-memory ↔ Prisma) without touching this service or anything above it.
 */
@Injectable()
export class IntentsService implements OnModuleDestroy {
  private readonly logger = new Logger(IntentsService.name);

  /**
   * Idempotency cache: maps caller-supplied keys → { intentId, expiresAt }.
   * Kept in-service (not in the repository) because it is a short-lived
   * request deduplication concern, not a durable persistence concern.
   */
  private readonly idempotencyCache = new Map<string, { intentId: string; expiresAt: number }>();

  /**
   * Keys whose creation is currently in flight → the in-flight creation
   * promise. Claimed synchronously in {@link create} so that concurrent
   * requests carrying the same idempotency key collapse onto a single created
   * intent instead of racing the check-then-set window (issue #274).
   */
  private readonly idempotencyInFlight = new Map<string, Promise<Intent>>();

  /**
   * In-memory audit log used as a fast read path and fallback when the DB is
   * unavailable. The canonical source of truth is the intent_audit_log table
   * (issue #217 / #62). Writes are fire-and-forget against PrismaService so a
   * DB write failure never blocks or rolls back the underlying state transition.
   */
  private readonly auditLog = new Map<string, IntentAuditEntry[]>();

  private readonly sizeLogTimer: ReturnType<typeof setInterval>;

  constructor(
    @Inject(INTENTS_REPOSITORY)
    private readonly repo: IIntentsRepository,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly stellarTxService: StellarTxService,
    private readonly prisma: PrismaService,
  ) {
    const sweepMs = Number(this.configService.get("intentRetentionSweepMs", { infer: true }) ?? STORE_SIZE_LOG_INTERVAL_MS);
    this.sizeLogTimer = setInterval(() => this.logStoreSize(), sweepMs || STORE_SIZE_LOG_INTERVAL_MS);
    // Allow the process to exit even if the timer is still active.
    this.sizeLogTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sizeLogTimer);
  }

  /**
   * Logs the store size and evicts stale terminal intents from the in-memory
   * adapter when it is the active backend. This keeps the memory footprint
   * bounded without affecting on-chain or durable storage paths.
   */
  async logStoreSize(): Promise<void> {
    const evicted = await this.evictTerminalIntents();
    const remaining = await this.repo.findAll();
    this.logger.log(`[store-monitor] intents store size: ${remaining.length} (evicted=${evicted})`);
  }

  private async evictTerminalIntents(): Promise<number> {
    const persistence = process.env.INTENTS_PERSISTENCE ?? "memory";
    const onchainEnabled = this.configService.get("onchainIntentsEnabled", { infer: true });
    if (persistence !== "memory" || onchainEnabled) {
      return 0;
    }

    const retentionDays = Number(this.configService.get("intentRetentionDays", { infer: true }) ?? 30);
    const retentionSeconds = Math.max(0, Number.isFinite(retentionDays) ? retentionDays * 86400 : 30 * 86400);
    const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;

    const all = await this.repo.findAll();
    const stale = all.filter((intent) => {
      if (!TERMINAL_STATES.includes(intent.state)) return false;
      const lastTerminalTs = intent.filledAt ?? intent.createdAt;
      return lastTerminalTs <= cutoff;
    });

    let evicted = 0;
    for (const intent of stale) {
      const removed = await this.repo.delete(intent.intentId);
      if (removed) evicted += 1;
      this.logger.warn(
        `[retention] evicted terminal intent ${intent.intentId} from in-memory store (state=${intent.state}, createdAt=${intent.createdAt})`,
      );
    }

    return evicted;
  }

  async create(
    data: Omit<Intent, "intentId" | "createdAt" | "state">,
    idempotencyKey?: string,
  ): Promise<Intent> {
    if (!idempotencyKey) {
      return this.persistNewIntent(data);
    }

    const now = Math.floor(Date.now() / 1000);

    // 1. Fast path — a previous request with this key already completed.
    const cached = this.idempotencyCache.get(idempotencyKey);
    if (cached && cached.expiresAt > now) {
      const cachedIntent = await this.repo.findById(cached.intentId);
      if (cachedIntent) {
        return cachedIntent;
      }
      // Cache entry outlived its intent — drop it and fall through.
      this.idempotencyCache.delete(idempotencyKey);
    }

    // 2. Race-safe claim. The check-and-set on `idempotencyInFlight` runs
    //    synchronously — there is no `await` between the `get` and the `set` —
    //    so two concurrent callers carrying the same key can never both proceed
    //    to create. The loser awaits the winner's in-flight promise and returns
    //    its result. The claim is taken *before* the conditional
    //    `registerOnChain()` await inside persistNewIntent(), so the race window
    //    is closed rather than merely shifted past the on-chain call.
    //
    //    The future Prisma-backed adapter (issue #1) must preserve the same
    //    guarantee at the storage layer: an atomic
    //    `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` followed by a
    //    read-back of the winning row, rather than a read-then-write.
    const inFlight = this.idempotencyInFlight.get(idempotencyKey);
    if (inFlight) {
      return inFlight;
    }

    const creation = this.persistNewIntent(data)
      .then((intent) => {
        this.idempotencyCache.set(idempotencyKey, {
          intentId: intent.intentId,
          expiresAt: now + IDEMPOTENCY_TTL_SECONDS,
        });
        return intent;
      })
      .finally(() => {
        this.idempotencyInFlight.delete(idempotencyKey);
      });

    this.idempotencyInFlight.set(idempotencyKey, creation);
    return creation;
  }

  /**
   * Build, optionally register on-chain, and persist a brand-new intent.
   * Contains no idempotency logic — deduplication is the caller's concern.
   */
  private async persistNewIntent(
    data: Omit<Intent, "intentId" | "createdAt" | "state">,
  ): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000);

    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline:
        data.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[data.srcChain] ?? DEFAULT_DEADLINE_SECONDS),
    };

    if (this.configService.get("onchainIntentsEnabled", { infer: true })) {
      await this.registerOnChain(intent);
    }

    await this.repo.save(intent);
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

  async get(id: string): Promise<Intent | undefined> {
    return this.repo.findById(id);
  }

  async getAll(): Promise<Intent[]> {
    return this.repo.findAll();
  }

  async getByState(state: IntentState): Promise<Intent[]> {
    return this.repo.findByState(state);
  }

  async getByUser(user: string): Promise<Intent[]> {
    return this.repo.findByUser(user);
  }

  /**
   * Batch-fetch the current record for each of `ids` (issue #275).
   *
   * IDs are de-duplicated; IDs with no matching record are simply omitted from
   * the result (callers get "missing" by comparing lengths, not a 404 per ID).
   *
   * This reuses `get()` per ID rather than adding a storage-layer method — fine
   * for the in-memory adapter. Issue #1's Prisma adapter should implement this
   * as a single `WHERE intent_id IN (...)` query for efficiency.
   */
  async getMany(ids: string[]): Promise<Intent[]> {
    const unique = [...new Set(ids)];
    const found = await Promise.all(unique.map((id) => this.get(id)));
    return found.filter((intent): intent is Intent => intent !== undefined);
  }

  async getAcceptedCountBySolver(solver: string): Promise<number> {
    const all = await this.repo.findAll();
    return all.filter((i) => i.state === "accepted" && i.solver === solver).length;
  }

  /**
   * Count the number of intents in "open" or "accepted" state for a user.
   *
   * Used by IntentsController.create() to enforce MAX_OPEN_INTENTS_PER_USER.
   * The query is a simple filter over findByUser so it works identically
   * against the in-memory adapter and — once the repo is swapped — can be
   * replaced with an efficient Prisma COUNT query without touching the service
   * interface (issue #1).
   */
  async countOpenByUser(user: string): Promise<number> {
    const userIntents = await this.repo.findByUser(user);
    return userIntents.filter(
      (i) => i.state === "open" || i.state === "accepted",
    ).length;
  }

  async update(id: string, patch: Partial<Intent>): Promise<Intent | null> {
    return this.repo.update(id, patch);
  }

  /**
   * Atomically accept an intent only if it is currently "open".
   * Delegates to the repository so both in-memory and Prisma adapters can
   * apply the conditional write atomically.
   *
   * The new deadline is set to now + CHAIN_FILL_WINDOW_DEFAULTS[srcChain]
   * so solvers on slower-settling chains get a proportionally longer window
   * and are not unfairly slashed for a deadline that was never realistic.
   * Returns null when the intent is not found or is not in the "open" state.
   */
  async acceptIfOpen(id: string, solver: string): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const now = Math.floor(Date.now() / 1000);
    const fillWindow =
      CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    return this.repo.acceptIfOpen(id, solver, now + fillWindow);
  }

  /**
   * Atomically fill an intent only if it is currently "accepted" by the given solver.
   * Returns null when the intent is not found, not accepted, or assigned to a
   * different solver.
   */
  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
  ): Promise<Intent | null> {
    return this.repo.fillIfAccepted(id, solver, patch);
  }

  /**
   * Atomically cancel an intent only if it is currently "open".
   * Returns null when the intent is not found or is not in the "open" state
   * (e.g. a concurrent accept() or sweeper expiry already transitioned it).
   */
  async cancelIfOpen(id: string): Promise<Intent | null> {
    return this.repo.cancelIfOpen(id);
  }

  /**
   * Atomically expire an intent only if it is currently "open".
   * Used by the sweeper so a concurrent user cancel() or solver accept()
   * always wins the race.
   */
  async expireIfOpen(id: string): Promise<Intent | null> {
    return this.repo.expireIfOpen(id);
  }

  /**
   * Atomically slash an intent only if it is currently "accepted".
   * Used by the sweeper so a concurrent solver fill() always wins the race.
   */
  async slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
  ): Promise<Intent | null> {
    return this.repo.slashIfAccepted(id, patch);
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
  getAuditLog(intentId: string, limit?: number, offset?: number): IntentAuditEntry[] {
    const entries = this.auditLog.get(intentId) ?? [];
    if (limit === undefined && offset === undefined) return entries;

    const safeLimit = Math.min(limit ?? 20, 100);
    const safeOffset = Math.max(0, offset ?? 0);
    return entries.slice(safeOffset, safeOffset + safeLimit);
  }
}
