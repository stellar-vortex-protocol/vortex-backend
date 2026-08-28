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
import { AppConfig } from "../config/configuration";
import { CHAIN_DEADLINE_DEFAULTS, DEFAULT_DEADLINE_SECONDS } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { INTENTS_REPOSITORY, IIntentsRepository } from "./intents.repository";

const STORE_SIZE_LOG_INTERVAL_MS = 60_000;

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
   * Append-only audit log keyed by intentId.
   * Issue #62 – once the audit-log table lands this will be written to
   * `intent_audit_log`; for now it survives in-memory for the process lifetime.
   */
  private readonly auditLog = new Map<string, IntentAuditEntry[]>();

  private readonly sizeLogTimer: ReturnType<typeof setInterval>;

  constructor(
    @Inject(INTENTS_REPOSITORY)
    private readonly repo: IIntentsRepository,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly stellarTxService: StellarTxService,
  ) {
    this.sizeLogTimer = setInterval(() => this.logStoreSize(), STORE_SIZE_LOG_INTERVAL_MS);
    // Allow the process to exit even if the timer is still active.
    this.sizeLogTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sizeLogTimer);
  }

  /** Logs the current intent store size so unbounded growth is observable. */
  async logStoreSize(): Promise<void> {
    const all = await this.repo.findAll();
    this.logger.log(`[store-monitor] intents store size: ${all.length}`);
  }

  async create(
    data: Omit<Intent, "intentId" | "createdAt" | "state">,
    idempotencyKey?: string,
  ): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000);

    if (idempotencyKey) {
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached && cached.expiresAt > now) {
        const cachedIntent = await this.repo.findById(cached.intentId);
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

    await this.repo.save(intent);

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
   * fully in the repository (the rollout fallback).
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

  async getAcceptedCountBySolver(solver: string): Promise<number> {
    const all = await this.repo.findAll();
    return all.filter((i) => i.state === "accepted" && i.solver === solver).length;
  }

  async update(id: string, patch: Partial<Intent>): Promise<Intent | null> {
    return this.repo.update(id, patch);
  }

  /**
   * Atomically accept an intent only if it is currently "open".
   * Delegates to the repository so both in-memory and Prisma adapters can
   * apply the conditional write atomically.
   * Returns null when the intent is not found or is not in the "open" state.
   */
  async acceptIfOpen(id: string, solver: string): Promise<Intent | null> {
    const now = Math.floor(Date.now() / 1000);
    return this.repo.acceptIfOpen(id, solver, now + 300);
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

  // ---------------------------------------------------------------------------
  // Audit trail (issue #62)
  // ---------------------------------------------------------------------------

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

    const entries = this.auditLog.get(intentId) ?? [];
    entries.push(entry);
    this.auditLog.set(intentId, entries);
  }

  getAuditLog(intentId: string): IntentAuditEntry[] {
    return this.auditLog.get(intentId) ?? [];
  }
}
