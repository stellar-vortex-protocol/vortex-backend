import { ConflictException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SupportedChain } from "../intents/intents.types";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord, SolverPendingPenalty } from "./solvers.types";
import { GuardianStateService } from "../governance/guardian-state.service";

export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";

export function solverSupports(
  solver: Pick<SolverRecord, "supportedChains" | "supportedTokens">,
  chain: SupportedChain | string,
  token: string,
): boolean {
  if (!solver.supportedChains.includes(chain as SupportedChain) && chain !== "*") {
    return false;
  }
  const normalizedToken = token.toUpperCase();
  return solver.supportedTokens.some((supportedToken) => supportedToken.toUpperCase() === normalizedToken);
}

export interface SlashDisputeRecord {
  submittedAt: number;
  reason: string;
  evidenceReference?: string;
}

export interface SlashRecord {
  slashId: string;
  solver: string;
  intentId: string;
  reason: string;
  timestamp: number;
  disputeStatus: "none" | "disputed" | "resolved-upheld" | "resolved-reversed";
  dispute?: SlashDisputeRecord;
}

/**
 * The subset of {@link SolverRecord} a solver is allowed to change about
 * itself. Every other field (address, bond, fill counters, volume,
 * registeredAt, isActive) is immutable and is never accepted here.
 */
export type MutableSolverProfile = Pick<
  SolverRecord,
  "name" | "supportedChains" | "supportedTokens" | "avgFillTime"
>;

/**
 * Orchestration layer for solver records.
 *
 * Business logic (counter initialisation, timestamp generation) lives here.
 * All persistence is delegated to the injected ISolversRepository so the
 * storage adapter can be swapped (in-memory → Prisma) without touching this
 * service or anything above it.
 */
@Injectable()
export class SolversService {
  private readonly logger = new Logger(SolversService.name);
  private readonly slashHistory = new Map<string, SlashRecord[]>();
  private readonly pendingPenalties = new Map<string, SolverPendingPenalty>();
  private slashSequence = 0;

  constructor(
    @Inject(SOLVERS_REPOSITORY)
    private readonly repo: ISolversRepository,
    @Optional() private readonly guardian?: GuardianStateService,
  ) {}

  /**
   * True while an active guardian blacklist covers `address` (issue #507).
   * Derived from guardian state; operators cannot clear it by reactivating.
   */
  isSuspended(address: string): boolean {
    return this.guardian?.isSolverSuspended(address) ?? false;
  }

  async getAll(): Promise<SolverRecord[]> {
    return this.repo.findAll();
  }

  async get(address: string): Promise<SolverRecord | undefined> {
    return this.repo.findByAddress(address);
  }

  /**
   * Apply a partial patch to a solver's *mutable* profile fields (issue #273).
   *
   * Array fields (`supportedChains`, `supportedTokens`) are replaced wholesale
   * rather than merged — the API is a PATCH over a full replacement list, and
   * a merge would make it impossible to drop a chain.
   *
   * Keys whose value is `undefined` are skipped, so a caller that spreads a
   * partially-populated DTO cannot accidentally blank out an existing value.
   * Immutable fields are structurally impossible to set: the patch type only
   * admits {@link MutableSolverProfile}.
   *
   * @returns the updated record, or `undefined` when no solver has that address.
   */
  async update(
    address: string,
    patch: Partial<MutableSolverProfile>,
  ): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;

    const applied: Partial<MutableSolverProfile> = {};
    if (patch.name !== undefined) applied.name = patch.name;
    if (patch.avgFillTime !== undefined) applied.avgFillTime = patch.avgFillTime;
    if (patch.supportedChains !== undefined) applied.supportedChains = patch.supportedChains;
    if (patch.supportedTokens !== undefined) applied.supportedTokens = patch.supportedTokens;

    const updated: SolverRecord = { ...solver, ...applied };
    return this.repo.save(updated);
  }

  async register(
    data: Omit<
      SolverRecord,
      "registeredAt" | "lastActiveAt" | "fillsCompleted" | "fillsFailed" | "totalVolume"
    >,
  ): Promise<SolverRecord> {
    const now = Math.floor(Date.now() / 1000);
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: now,
      lastActiveAt: now,
    };
    return this.repo.save(solver);
  }

  async deregister(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async markLive(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: true, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async markOffline(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async deactivate(address: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async reactivate(address: string): Promise<SolverRecord | null> {
    if (this.isSuspended(address)) {
      throw new ConflictException("Solver is suspended by an active guardian action");
    }
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: true };
    return this.repo.save(updated);
  }

  /**
   * Register a solver from an on-chain SolverRegistered event (issue #399).
   *
   * Creates a new solver record with source="chain" and the bond amount
   * observed on-chain.  Fields not present in the event (name, supported
   * chains/tokens) are set to sensible defaults and can be updated later via
   * POST /solvers metadata update.
   */
  async registerFromChain(params: {
    address: string;
    bondAmount: string;
    name: string;
    isActive: boolean;
    supportedChains: SolverRecord["supportedChains"];
    supportedTokens: SolverRecord["supportedTokens"];
    chainUpdatedLedger: number;
  }): Promise<SolverRecord> {
    const now = Math.floor(Date.now() / 1000);
    const solver: SolverRecord = {
      address: params.address,
      name: params.name,
      bondAmount: params.bondAmount,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      avgFillTime: 0,
      isActive: params.isActive,
      registeredAt: now,
      lastActiveAt: now,
      supportedChains: params.supportedChains,
      supportedTokens: params.supportedTokens,
      source: "chain",
      chainUpdatedLedger: params.chainUpdatedLedger,
    };
    return this.repo.save(solver);
  }

  /**
   * Apply a partial update from an on-chain event projection (issue #399).
   *
   * Only the fields present in `update` are changed — all other fields remain
   * as stored.  Guards on chainUpdatedLedger are enforced by the caller
   * (SolverRegistryEventsService) before this method is called.
   *
   * This is the write path for all chain-sourced projections (BondDeposited,
   * BondWithdrawn, SolverDeactivated, etc.).
   */
  async applyChainUpdate(
    address: string,
    update: Partial<Pick<SolverRecord, "bondAmount" | "isActive" | "source" | "chainUpdatedLedger">>,
  ): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated: SolverRecord = { ...solver, ...update, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  /**
   * Records a successful fill for `address`.
   *
   * Bumps `fillsCompleted`, adds `fillAmount` to the cumulative `totalVolume`,
   * and refreshes `lastActiveAt` so liveness checks reflect the fill. All
   * arithmetic stays in bigint so a large fill cannot lose precision; the
   * rolling `avgFillTime` is intentionally left alone because only the
   * controller has the accept→fill elapsed time and passing it through on
   * every fill is not currently wired up.
   *
   * @param address    Solver address.
   * @param fillAmount Fill amount in the destination token's base units. When
   *                   omitted, volume is left unchanged (counters still move).
   * @returns the updated record, or `null` when the solver is unknown.
   */
  async recordSuccessfulFill(address: string, fillAmount?: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;

    const now = Math.floor(Date.now() / 1000);
    let totalVolume = solver.totalVolume;
    if (fillAmount !== undefined) {
      try {
        totalVolume = (BigInt(solver.totalVolume) + BigInt(fillAmount)).toString();
      } catch {
        // A malformed amount must not lose the fill counter — log and keep
        // the existing volume rather than throwing inside a request path.
        this.logger.error(
          `[volume] ignoring non-integer fillAmount="${fillAmount}" for solver=${address}`,
        );
      }
    }

    const updated: SolverRecord = {
      ...solver,
      fillsCompleted: solver.fillsCompleted + 1,
      totalVolume,
      lastActiveAt: now,
    };
    return this.repo.save(updated);
  }

  /**
   * Records that a solver accepted an intent and then missed its fill
   * deadline by entering a pending-slash state.
   *
   * Bumps the local fillsFailed counter immediately (optimistic increment)
   * and stores a "pending" penalty entry so callers can later either confirm
   * the penalty once the on-chain slash event arrives, or roll it back if the
   * on-chain submission never confirms.
   *
   * The authoritative bond reduction happens on-chain via
   * SolverRegistryService.slashSolver; bondAmount is reconciled in
   * confirmPenalty() once the solver_slashed event is observed.
   */
  async recordFailedFill(address: string, intentId: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, fillsFailed: solver.fillsFailed + 1 };
    const saved = await this.repo.save(updated);

    // Track this as a pending penalty until on-chain confirmation.
    this.pendingPenalties.set(intentId, {
      intentId,
      solverAddress: address,
      detectedAt: Math.floor(Date.now() / 1000),
      state: "pending",
    });

    return saved;
  }

  /**
   * Confirms a pending penalty once the solver_slashed on-chain event is
   * ingested by EventIngestionService.
   *
   * Reconciles the solver's bondAmount downward by slashAmount and marks the
   * penalty as "confirmed" so the in-memory record reflects the real on-chain
   * balance.
   *
   * @param intentId   The intent whose slash is now confirmed on-chain.
   * @param slashAmount  The amount slashed from the solver's bond (as a string,
   *                     matching bondAmount's representation).
   */
  async confirmPenalty(intentId: string, slashAmount: string): Promise<SolverRecord | null> {
    const penalty = this.pendingPenalties.get(intentId);
    if (!penalty || penalty.state !== "pending") {
      this.logger.warn(
        `confirmPenalty called for intentId=${intentId} but no pending penalty found (state=${penalty?.state ?? "none"})`,
      );
      return null;
    }

    const solver = await this.repo.findByAddress(penalty.solverAddress);
    if (!solver) {
      this.logger.error(
        `confirmPenalty: solver ${penalty.solverAddress} not found when confirming slash for intent ${intentId}`,
      );
      return null;
    }

    // Reconcile bondAmount: clamp to 0 so we never go negative.
    const current = BigInt(solver.bondAmount);
    const slash = BigInt(slashAmount);
    const newBond = current > slash ? current - slash : 0n;

    const updated = { ...solver, bondAmount: newBond.toString() };
    const saved = await this.repo.save(updated);

    this.pendingPenalties.set(intentId, {
      ...penalty,
      state: "confirmed",
      confirmedSlashAmount: slashAmount,
    });

    this.logger.log(
      `[penalty] confirmed: solver=${penalty.solverAddress} intent=${intentId} slashed=${slashAmount} newBond=${newBond}`,
    );

    return saved;
  }

  /**
   * Rolls back a pending penalty when the on-chain slash submission fails or
   * is never confirmed.
   *
   * Decrements fillsFailed (reversing the optimistic increment from
   * recordFailedFill) and marks the penalty as "failed" so operators can
   * investigate the discrepancy.
   *
   * @param intentId  The intent whose slash submission failed.
   * @param solverAddress  Optional fallback for callers that track the
   *   penalty durably (the slashing saga, issue #397): when the in-memory
   *   pending entry is gone — e.g. lost in a restart — the fillsFailed
   *   increment is still reverted for this solver. Callers passing it must
   *   guarantee they compensate at most once per intent.
   */
  async rollbackPenalty(intentId: string, solverAddress?: string): Promise<SolverRecord | null> {
    const penalty = this.pendingPenalties.get(intentId);
    if (!penalty && solverAddress) {
      const solver = await this.repo.findByAddress(solverAddress);
      if (!solver) return null;
      this.logger.warn(
        `[penalty] rolled back without in-memory record: solver=${solverAddress} intent=${intentId}`,
      );
      return this.repo.save({ ...solver, fillsFailed: Math.max(0, solver.fillsFailed - 1) });
    }
    if (!penalty || penalty.state !== "pending") {
      this.logger.warn(
        `rollbackPenalty called for intentId=${intentId} but no pending penalty found (state=${penalty?.state ?? "none"})`,
      );
      return null;
    }

    const solver = await this.repo.findByAddress(penalty.solverAddress);
    if (!solver) {
      this.logger.error(
        `rollbackPenalty: solver ${penalty.solverAddress} not found when rolling back penalty for intent ${intentId}`,
      );
      return null;
    }

    // Clamp at 0 to guard against double-rollback edge cases.
    const newFailed = Math.max(0, solver.fillsFailed - 1);
    const updated = { ...solver, fillsFailed: newFailed };
    const saved = await this.repo.save(updated);

    this.pendingPenalties.set(intentId, { ...penalty, state: "failed" });

    this.logger.warn(
      `[penalty] rolled back: solver=${penalty.solverAddress} intent=${intentId} (on-chain slash did not confirm)`,
    );

    return saved;
  }

  async recordSlash(
    solverAddress: string,
    intentId: string,
    reason: string,
    timestamp: number,
  ): Promise<SlashRecord | null> {
    const solver = await this.repo.findByAddress(solverAddress);
    if (!solver) return null;

    const record: SlashRecord = {
      slashId: `slash-${++this.slashSequence}`,
      solver: solverAddress,
      intentId,
      reason,
      timestamp,
      disputeStatus: "none",
    };

    const existing = this.slashHistory.get(solverAddress) ?? [];
    existing.push(record);
    this.slashHistory.set(solverAddress, existing);
    return record;
  }

  async getSlashHistory(
    address: string,
    page = 1,
    pageSize = 25,
  ): Promise<{ records: SlashRecord[]; page: number; pageSize: number; total: number }> {
    const records = this.slashHistory.get(address) ?? [];
    const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const start = (page - 1) * pageSize;
    const pageRecords = sorted.slice(start, start + pageSize);

    return {
      records: pageRecords,
      page,
      pageSize,
      total: sorted.length,
    };
  }

  /** Look up a slash by its id across all solvers (used by the dispute flow). */
  async getSlash(slashId: string): Promise<SlashRecord | null> {
    for (const records of this.slashHistory.values()) {
      const found = records.find((entry) => entry.slashId === slashId);
      if (found) return found;
    }
    return null;
  }

  async submitDispute(
    address: string,
    slashId: string,
    reason: string,
    evidenceReference?: string,
  ): Promise<SlashRecord | null> {
    const records = this.slashHistory.get(address) ?? [];
    const record = records.find((entry) => entry.slashId === slashId);
    if (!record) return null;

    record.disputeStatus = "disputed";
    record.dispute = {
      submittedAt: Math.floor(Date.now() / 1000),
      reason,
      evidenceReference,
    };

    return record;
  }

  async resolveDispute(
    address: string,
    slashId: string,
    resolution: "resolved-upheld" | "resolved-reversed",
    reviewer?: string,
    note?: string,
  ): Promise<SlashRecord | null> {
    const records = this.slashHistory.get(address) ?? [];
    const record = records.find((entry) => entry.slashId === slashId);
    if (!record) return null;

    record.disputeStatus = resolution;
    if (!record.dispute) {
      record.dispute = {
        submittedAt: Math.floor(Date.now() / 1000),
        reason: note ?? "manual review",
        evidenceReference: reviewer ? `reviewer:${reviewer}` : undefined,
      };
    }

    return record;
  }
}
