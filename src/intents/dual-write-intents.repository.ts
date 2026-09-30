import { Logger } from "@nestjs/common";
import {
  IdempotentCreateResult,
  IIntentsRepository,
  InMemoryIntentsRepository,
  IntentPatch,
  isVersionConflict,
  MutationResult,
} from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { Intent, IntentState } from "./intents.types";
import { MetricsService } from "../metrics/metrics.service";

/**
 * `INTENTS_STORE=dual` adapter (issue #404).
 *
 * The in-memory store stays authoritative: every read is served from it and
 * every mutation's outcome (including version conflicts and failed state
 * guards) is decided by it. Each successful write is then mirrored to
 * Postgres with {@link PrismaIntentsRepository.saveIfNewer}, a version-guarded
 * upsert, so a mirror that lands out of order can never regress a row.
 *
 * A failed mirror write is logged and counted
 * (`vortex_intents_dual_write_failures_total`) but never fails the request —
 * the consistency verifier (IntentsStoreVerifierService) reports the
 * resulting drift so it can be investigated before cutting over to
 * `INTENTS_STORE=postgres`.
 */
export class DualWriteIntentsRepository implements IIntentsRepository {
  private readonly logger = new Logger(DualWriteIntentsRepository.name);

  constructor(
    readonly primary: InMemoryIntentsRepository,
    readonly secondary: PrismaIntentsRepository,
    private readonly metrics?: MetricsService,
  ) {}

  /**
   * Hydrate the in-memory store from Postgres at boot so a restarted replica
   * keeps serving intents written before the restart, then push any rows only
   * memory holds. Returns how many rows moved in each direction.
   */
  async backfill(): Promise<{ loadedFromPostgres: number; pushedToPostgres: number }> {
    const [fromDb, inMemory] = await Promise.all([this.secondary.findAll(), this.primary.findAll()]);
    const dbIds = new Set(fromDb.map((i) => i.intentId));

    let loadedFromPostgres = 0;
    for (const intent of fromDb) {
      const local = this.primary.findById(intent.intentId);
      if (!local || local.version < intent.version) {
        this.primary.save(intent);
        loadedFromPostgres++;
      }
    }

    let pushedToPostgres = 0;
    for (const intent of inMemory) {
      if (dbIds.has(intent.intentId)) continue;
      await this.mirror("backfill", intent);
      pushedToPostgres++;
    }
    return { loadedFromPostgres, pushedToPostgres };
  }

  async save(intent: Intent): Promise<Intent> {
    const saved = this.primary.save(intent);
    await this.mirror("save", saved);
    return saved;
  }

  async createIdempotent(
    intent: Intent,
    idempotencyKey: string,
    minCreatedAt: number,
  ): Promise<IdempotentCreateResult> {
    const result = this.primary.createIdempotent(intent, idempotencyKey, minCreatedAt);
    if (result.created) {
      try {
        await this.secondary.createIdempotent(result.intent, idempotencyKey, minCreatedAt);
      } catch (err) {
        this.recordFailure("createIdempotent", result.intent.intentId, err);
      }
    }
    return result;
  }

  findByIdempotencyKey(idempotencyKey: string, minCreatedAt: number): Intent | undefined {
    return this.primary.findByIdempotencyKey(idempotencyKey, minCreatedAt);
  }

  findById(id: string): Intent | undefined {
    return this.primary.findById(id);
  }

  findManyByIds(ids: string[]): Intent[] {
    return this.primary.findManyByIds(ids);
  }

  findAll(): Intent[] {
    return this.primary.findAll();
  }

  findByState(state: IntentState): Intent[] {
    return this.primary.findByState(state);
  }

  findByUser(user: string): Intent[] {
    return this.primary.findByUser(user);
  }

  countAcceptedBySolver(solver: string): number {
    return this.primary.countAcceptedBySolver(solver);
  }

  countActiveByUser(user: string): number {
    return this.primary.countActiveByUser(user);
  }

  update(id: string, patch: IntentPatch, expectedVersion: number): Promise<MutationResult> {
    return this.mirrored("update", this.primary.update(id, patch, expectedVersion));
  }

  /**
   * Deletes from memory only. Retention eviction exists to bound process
   * memory; Postgres keeps the durable history.
   */
  delete(id: string): boolean {
    return this.primary.delete(id);
  }

  acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.mirrored("acceptIfOpen", this.primary.acceptIfOpen(id, solver, newDeadline, now, expectedVersion));
  }

  fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    now?: number,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.mirrored("fillIfAccepted", this.primary.fillIfAccepted(id, solver, patch, now, expectedVersion));
  }

  extendDeadlineIfAccepted(id: string, newDeadline: number, expectedVersion?: number): Promise<MutationResult> {
    return this.mirrored(
      "extendDeadlineIfAccepted",
      this.primary.extendDeadlineIfAccepted(id, newDeadline, expectedVersion),
    );
  }

  cancelIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.mirrored("cancelIfOpen", this.primary.cancelIfOpen(id, expectedVersion));
  }

  expireIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.mirrored("expireIfOpen", this.primary.expireIfOpen(id, expectedVersion));
  }

  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.mirrored("slashIfAccepted", this.primary.slashIfAccepted(id, patch, expectedVersion));
  }

  private async mirrored(operation: string, result: MutationResult): Promise<MutationResult> {
    if (result && !isVersionConflict(result)) await this.mirror(operation, result);
    return result;
  }

  private async mirror(operation: string, intent: Intent): Promise<void> {
    try {
      await this.secondary.saveIfNewer(intent);
    } catch (err) {
      this.recordFailure(operation, intent.intentId, err);
    }
  }

  private recordFailure(operation: string, intentId: string, err: unknown): void {
    this.metrics?.recordDualWriteFailure(operation);
    this.logger.error(
      `[dual-write] Postgres mirror failed op=${operation} intent=${intentId}: ${(err as Error).message}`,
    );
  }
}
