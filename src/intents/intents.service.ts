import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Intent, IntentAuditEntry, IntentState, PendingIntentOp } from "./intents.types";
import {
  INTENTS_REPOSITORY,
  IIntentsRepository,
  IntentPatch,
  isVersionConflict,
  MutationResult,
} from "./intents.repository";
import { INTENTS_UNIT_OF_WORK, IIntentsUnitOfWork } from "./intents.unit-of-work";
import { IntentDeadlineScheduler } from "./intents-deadline.jobs";
import { transition, TransitionContext, TransitionPlan } from "./state-machine";
import { IOutboxWriter, NewOutboxEntry } from "../soroban/outbox.repository";
import { buildOutboxInvocation, createIntentEntry } from "../soroban/outbox-operations";
import { AppConfig } from "../config/configuration";
import {
  CHAIN_DEADLINE_DEFAULTS,
  DEFAULT_DEADLINE_SECONDS,
  CHAIN_FILL_WINDOW_DEFAULTS,
  DEFAULT_FILL_WINDOW_SECONDS,
} from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { ShadowService, type ShadowObservationRequest } from "../soroban/shadow.service";
import { SHADOW_TRANSITIONS, type ShadowTransition } from "../soroban/shadow.types";
import { MetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProtocolParamsService } from "../governance/params.service";
import { FeatureFlagService } from "../flags/feature-flag.service";
import { CacheService } from "../cache/cache.service";
import { TokensService } from "../tokens/tokens.service";
import { FILL_LEDGER_UNIT_OF_WORK, IFillLedgerUnitOfWork } from "./fill-ledger.unit-of-work";
import { usdValueOf } from "../solvers/solver-fills.repository";
import { SolverFillOutcome, SolverFillRecord } from "../solvers/solver-fills.types";
import { createLogger } from "../common/logger";
import { LOG_EVENTS } from "../common/log-schema";

const TERMINAL_STATES: IntentState[] = ["filled", "cancelled", "expired", "slashed"];

/**
 * Sentinel `from_state` for the transition at intent creation — into `open`
 * on the in-memory path, or into `pending_open` when the onchain rollout
 * parks the fresh intent (issue #385).
 *
 * Not an {@link IntentState}: creation has no prior state, and inventing one
 * would put a value in the `from_state` label that no lifecycle edge can
 * produce. Bounded (one extra series), and it keeps the funnel's denominator
 * honest.
 */
const NONE_STATE = "none";

/**
 * Slack below an intent's `createdAt` when reading its persisted audit trail
 * (issue #407): an entry written on a replica whose clock lags may carry a
 * slightly earlier timestamp than the creation time recorded elsewhere.
 */
export const AUDIT_CLOCK_SKEW_SECONDS = 3600;

/** pending_* state each chain write parks in (issue #385). */
const PENDING_STATE_BY_OP: Record<PendingIntentOp, IntentState> = {
  create: "pending_open",
  accept: "pending_accepted",
  fill: "pending_filled",
  cancel: "pending_cancelled",
};

/** Confirmed base state each pending_* marker settles back to (issue #385). */
const CONFIRMED_STATE_BY_PENDING: Partial<Record<IntentState, IntentState>> = {
  pending_open: "open",
  pending_accepted: "accepted",
  pending_filled: "filled",
  pending_cancelled: "cancelled",
};

/**
 * Settlement-contract method each write broadcasts (issue #385). Names mirror
 * the shadow hooks (`observeAccept`/`observeFill`/`cancelIfOpen`) so the
 * simulated and the real invocation stay the same call.
 */
const ONCHAIN_METHOD_BY_OP: Record<PendingIntentOp, string> = {
  create: "create_intent",
  accept: "accept_intent",
  fill: "fill_intent",
  cancel: "cancel_intent",
};

/**
 * Runtime check that `transition` is one of the five the shadow monitor models.
 *
 * A mis-wired call site is logged and dropped rather than thrown on, so a shadow
 * bug can never become a 500 on the intent path, and so an unknown label can
 * never create a new Prometheus series.
 */
function isKnownShadowTransition(transition: ShadowTransition): boolean {
  return (SHADOW_TRANSITIONS as readonly string[]).includes(transition);
}

/** How long a completed idempotency-key result stays replayable. */
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

/**
 * Compute the USD value of a base-unit amount at a given token price (issue #440).
 *
 * Uses integer arithmetic for the amount (BigInt) so large base-unit values do
 * not lose precision before the float conversion; the price is scaled to 1e8
 * to keep the multiplication in integer space.  Returns `undefined` when the
 * price is unknown — historical rows are never backfilled with fabricated
 * values.
 */
function computeUsdValue(
  srcAmount: string,
  decimals: number,
  priceUsd: number | undefined,
): number | undefined {
  if (priceUsd === undefined || priceUsd === null || !Number.isFinite(priceUsd)) return undefined;
  try {
    const amount = BigInt(srcAmount);
    const scale = 10n ** BigInt(decimals);
    const scaled = amount * BigInt(Math.round(priceUsd * 1e8));
    return Number(scaled / (scale * 100_000_000n));
  } catch {
    return undefined;
  }
}

/**
 * Narrow an optimistic-concurrency mutation result to the written record.
 *
 * `VersionConflict` means a concurrent writer won the race — the guarded
 * transition did not happen — which every service-level caller treats exactly
 * like "no match": `null`. The conflict details remain available to callers
 * that talk to the repository directly (see `etag.ts` / `preconditionFailed`).
 */
function written(result: MutationResult): Intent | null {
  return result !== null && !isVersionConflict(result) ? result : null;
}

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
 * Upper bound on re-read → retry attempts inside {@link IntentsService.mutateWithRetry}.
 * Three conflicts in a row means a hot row; giving up keeps a retrying writer
 * from starving concurrent readers (issue #405).
 */
export const MAX_VERSION_RETRIES = 3;

/** Payload for creating a new intent. */
export type NewIntentData = Omit<Intent, "intentId" | "createdAt" | "state">;

/**
 * Orchestration layer for intents.
 *
 * Business logic (ID generation, default state, deadline defaulting,
 * idempotency cache, audit log) lives here. All persistence is delegated
 * to the injected IIntentsRepository so the storage adapter can be swapped
 * (in-memory ↔ Prisma) without touching this service or anything above it.
 */
@Injectable()
export class IntentsService {
  private readonly logger = createLogger(IntentsService.name);

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

  constructor(
    @Inject(INTENTS_REPOSITORY)
    private readonly repo: IIntentsRepository,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly stellarTxService: StellarTxService,
    private readonly prisma: PrismaService,
    private readonly protocolParamsService: ProtocolParamsService,
    /**
     * Shadow-mode divergence monitor (issue #401).
     *
     * Injected `@Optional()` on purpose: the monitor is observability, not a
     * correctness dependency, and the intent path must keep working — including
     * in the unit-test harnesses that construct this service directly — when
     * the soroban module is not in the graph.
     */
    @Optional() private readonly shadowService?: ShadowService,
    /**
     * SLO counters for the intent funnel (issue #481).
     *
     * `@Optional()` for the same reason as the shadow monitor: the dashboards
     * are observability, and a unit harness that constructs this service
     * directly must not have to provide a metrics registry. `MetricsModule` is
     * `@Global()` and registered in `AppModule`, so in the running application
     * this is always present.
     */
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly flags?: FeatureFlagService,
    /**
     * Transactional outbox unit of work (issue #396).
     *
     * Present only where the durable outbox is wired (and in the crash-injection
     * harnesses): while it is injected, `create()` commits the intent row and its
     * `create_intent` outbox row atomically and the relay submits later, instead
     * of calling the settlement contract inline. Absent — the default graph at
     * HEAD — creation keeps the direct, synchronous registration path.
     */
    @Optional() @Inject(INTENTS_UNIT_OF_WORK)
    private readonly unitOfWork?: IIntentsUnitOfWork,
    /**
     * Deadline-job scheduler (issue #550). Registers the expire/fill-window
     * wake-ups whenever an intent is created or its fill window starts, so the
     * sweeper settles deadlines through the jobs queue instead of polling.
     * `@Optional()` because unit harnesses that never exercise deadline jobs
     * construct this service directly without one.
     */
    @Optional() private readonly deadlines?: IntentDeadlineScheduler,
    /**
     * Per-fill ledger (issue #417). When wired, fill and failure transitions
     * commit their `solver_fills` row atomically with the state change.
     * Optional (and possibly null) so direct-construction harnesses keep the
     * plain repository path.
     */
    @Optional() @Inject(FILL_LEDGER_UNIT_OF_WORK)
    private readonly fillLedger?: IFillLedgerUnitOfWork | null,
    /** Price oracle for the fill-time USD snapshot (issue #417). */
    @Optional() private readonly tokens?: TokensService,
    /** Read cache (issue #414): every intent write invalidates stats + leaderboard. */
    @Optional() private readonly cache?: CacheService,
  ) {}

  /**
   * Drop the cached read models derived from intents (issue #414). Awaited
   * by every write so a read issued after it on this replica is never served
   * the pre-write value; never throws.
   */
  private async changed(): Promise<void> {
    await this.cache?.invalidate("stats", "leaderboard");
  }

  /**
   * Run a fill/failure transition and, when it wins, append its
   * `solver_fills` row in the same unit of work (issue #417).
   */
  private async withFillRecord(
    outcome: Exclude<SolverFillOutcome, "reversed">,
    now: number,
    mutate: (repo: IIntentsRepository) => Promise<MutationResult> | MutationResult,
  ): Promise<MutationResult> {
    if (!this.fillLedger) return mutate(this.repo);
    return this.fillLedger.run(async ({ intents, fills }) => {
      const result = await mutate(intents);
      if (result !== null && !isVersionConflict(result) && result.solver) {
        await fills.record(await this.buildFillRecord(result, outcome, now));
      }
      return result;
    });
  }

  /**
   * Build the immutable fill row for `intent` (issue #417). The USD value is
   * snapshotted from the token price oracle now — delivered destination
   * amount for a fill, source amount at stake for a failure — and is never
   * recomputed afterwards.
   */
  private async buildFillRecord(
    intent: Intent,
    outcome: Exclude<SolverFillOutcome, "reversed">,
    now: number,
  ): Promise<SolverFillRecord> {
    const base = {
      intentId: intent.intentId,
      solver: intent.solver as string,
      chain: intent.srcChain,
      srcAmount: /^\d+$/.test(intent.srcAmount) ? intent.srcAmount : "0",
      ledger: null,
    };
    if (outcome === "filled") {
      const dstAmount = intent.fillAmount && /^\d+$/.test(intent.fillAmount) ? intent.fillAmount : "0";
      const filledAt = intent.filledAt ?? now;
      const price = await this.oraclePrice(() => this.tokens?.resolveDstToken(intent.dstToken.contract));
      return {
        ...base,
        dstAmount,
        usdValue: usdValueOf(dstAmount, intent.dstToken.decimals, price),
        fillSeconds: filledAt - intent.createdAt,
        outcome,
        createdAt: filledAt,
      };
    }
    const price = await this.oraclePrice(() =>
      this.tokens?.resolveSrcToken(intent.srcChain, intent.srcToken.address),
    );
    return {
      ...base,
      dstAmount: null,
      usdValue: usdValueOf(base.srcAmount, intent.srcToken.decimals, price),
      fillSeconds: null,
      outcome,
      createdAt: intent.slashedAt ?? now,
    };
  }

  /** Current oracle price, or undefined when unknown; a lookup failure never fails the write. */
  private async oraclePrice(
    lookup: () => Promise<{ priceUSD: number } | undefined> | undefined,
  ): Promise<number | undefined> {
    try {
      const token = await lookup();
      return token && token.priceUSD > 0 ? token.priceUSD : undefined;
    } catch (err) {
      this.logger.warn(`[fills] price lookup failed, recording usd_value=null: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Settle a slashed intent whose slash the slashing saga cancelled
   * (issue #397): move it to `filled` (a fill proof landed) or `expired`,
   * and append the compensating `reversed` fill row — plus a `filled` row
   * when the fill landed — in the same unit of work (issue #417).
   *
   * @returns the updated intent, or null when it is no longer `slashed`.
   */
  async settleCancelledSlash(
    id: string,
    toState: "filled" | "expired",
    fillTxHash?: string,
    now = Math.floor(Date.now() / 1000),
  ): Promise<Intent | null> {
    const run = async (repo: IIntentsRepository, fills?: { record: (f: SolverFillRecord) => Promise<void> }) => {
      const current = await repo.findById(id);
      if (!current || current.state !== "slashed") return null;
      const patch: IntentPatch = toState === "filled" ? { state: "filled", txHash: fillTxHash } : { state: "expired" };
      const updated = written(await repo.update(id, patch));
      if (updated && fills && current.solver) {
        const failure = await this.buildFillRecord(current, "failed", now);
        await fills.record({ ...failure, outcome: "reversed" });
        if (toState === "filled") await fills.record(await this.buildFillRecord(updated, "filled", now));
      }
      return updated;
    };
    const updated = this.fillLedger
      ? await this.fillLedger.run(({ intents, fills }) => run(intents, fills))
      : await run(this.repo);
    if (updated) await this.changed();
    return updated;
  }

  /**
   * Lifecycle hook (Nest `OnModuleDestroy`): drops the in-memory idempotency
   * caches. This service owns no timers — deadline wake-ups live in the jobs
   * queue — so the caches are the only teardown the instance has. Called
   * directly by the unit harnesses after each case for the same reason.
   */
  onModuleDestroy(): void {
    this.idempotencyCache.clear();
    this.idempotencyInFlight.clear();
  }

  /**
   * Logs the store size and evicts stale terminal intents from the in-memory
   * adapter when it is the active backend. This keeps the memory footprint
   * bounded without affecting on-chain or durable storage paths.
   *
   * Runs as the `intents.store-size` background job (see
   * intents-maintenance.jobs.ts, issue #494) rather than a local timer.
   */
  async logStoreSize(): Promise<void> {
    const evicted = await this.evictTerminalIntents();
    const remaining = await this.repo.findAll();
    this.logger.info("intents store size", { storeSize: remaining.length, evicted });
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
      this.logger.warn("evicted terminal intent from in-memory store", {
        intentId: intent.intentId,
        state: intent.state,
        createdAt: intent.createdAt,
      });
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
   * Issue #429 — Atomically create up to N intents (all-or-nothing).
   * If any intent fails validation or user open-intent limits, NO intents are created
   * and per-item validation errors are returned.
   */
  async createBatch(
    items: NewIntentData[],
  ): Promise<{ created: Intent[]; errors: { index: number; field?: string; message: string }[] }> {
    const errors: { index: number; field?: string; message: string }[] = [];
    const userOpenCounts = new Map<string, number>();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const user = item.user?.toLowerCase();

      if (!user) {
        errors.push({ index: i, field: "user", message: "User address is required" });
        continue;
      }

      if (!userOpenCounts.has(user)) {
        const standingCount = await this.countOpenByUser(item.user);
        userOpenCounts.set(user, standingCount);
      }

      const currentCount = userOpenCounts.get(user)!;
      if (currentCount + 1 > MAX_OPEN_INTENTS_PER_USER) {
        errors.push({
          index: i,
          field: "user",
          message: `Open-intent cap reached — max ${MAX_OPEN_INTENTS_PER_USER} open/accepted intents per user`,
        });
      } else {
        userOpenCounts.set(user, currentCount + 1);
      }
    }

    if (errors.length > 0) {
      return { created: [], errors };
    }

    const created: Intent[] = [];
    for (const item of items) {
      const intent = await this.persistNewIntent(item);
      created.push(intent);
    }

    return { created, errors: [] };
  }

  /**
   * Build, optionally register on-chain, and persist a brand-new intent.
   * Contains no idempotency logic — deduplication is the caller's concern.
   */
  /**
   * Creation-time source-deposit-verification verdict (issue #403).
   *
   * - `evm.depositVerificationEnabled=false` → everything is marked verified
   *   up front (`skipped`) so the verify loop never picks it up.
   * - Non-EVM source chains (Stellar) are out of the EVM verifier's scope →
   *   `skipped`, verified.
   * - Otherwise the intent is born `pending` / unverified until the
   *   source-deposit verification service ticks it.
   */
  private initialSrcVerification(
    srcChain: NewIntentData["srcChain"],
    now: number,
  ): Pick<Intent, "srcVerified" | "srcVerification"> {
    const enabled =
      this.configService.get("evm", { infer: true })?.depositVerificationEnabled === true;
    if (!enabled) {
      return {
        srcVerified: true,
        srcVerification: {
          status: "skipped",
          checkedAt: now,
          detail: "deposit verification disabled",
        },
      };
    }
    if (srcChain === "stellar") {
      return {
        srcVerified: true,
        srcVerification: { status: "skipped", checkedAt: now, detail: "non-EVM source chain" },
      };
    }
    return { srcVerified: false, srcVerification: { status: "pending", checkedAt: now } };
  }

  private async persistNewIntent(
    data: Omit<Intent, "intentId" | "createdAt" | "state">,
  ): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000);

    // Snapshot governance-controlled parameters at creation time so in-flight
    // intents are evaluated against the rules that were active when the user
    // submitted (issue #500).
    const paramsSnapshot = this.protocolParamsService.snapshotForChain(data.srcChain);
    const defaultDeadline = data.deadline ?? now + paramsSnapshot.deadlineSeconds;

    const intent: Intent = {
      // Issue #403: stamp the creation-time source-deposit verdict first so
      // the row is self-describing from its first write — the verify loop
      // picks intents up by `srcVerified === false` and never re-checks
      // "skipped"/"grandfathered" ones. An explicit caller-supplied verdict
      // (imports, seeds) wins over this default.
      ...this.initialSrcVerification(data.srcChain, now),
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: defaultDeadline,
      paramsVersion: paramsSnapshot.version,
      usdValueAtCreate: computeUsdValue(
        data.srcAmount,
        data.srcToken.decimals,
        data.srcToken.priceUSD,
      ),
      // Issue #385: both creation paths carry the pending keys — undefined
      // until a chain write is in flight — so the in-memory and on-chain
      // paths return an identical shape.
      pendingTxHash: undefined,
      pendingOp: undefined,
    };

    // ONCHAIN_INTENTS_ENABLED is the default; the `onchain-intents-enabled`
    // runtime flag (issue #495) can roll it out per chain / percentage.
    const onchain = await this.isOnchainWrite(intent);
    if (onchain && this.unitOfWork) {
      // Issue #396: intent row + create_intent outbox row commit atomically;
      // OutboxRelayService submits afterwards, never inside this request.
      // Issue #385: nothing has reached the chain yet, so the row is born
      // `pending_open` — `pendingTxHash` is attached once the confirmation
      // watcher observes the relay's transaction.
      intent.state = "pending_open";
      intent.pendingOp = "create";
      await this.unitOfWork.run(async ({ intents, outbox }) => {
        await this.enqueueOnchain(outbox, intent);
        await intents.save(intent);
      });
    } else if (onchain) {
      // Registration must land before the row exists: a failed broadcast
      // rejects the whole creation, leaving no dangling `pending_open` record
      // behind (issue #385).
      const txHash = await this.registerOnChain(intent);
      intent.state = "pending_open";
      intent.pendingOp = "create";
      intent.pendingTxHash = txHash;
      await this.repo.save(intent);
    } else {
      await this.repo.save(intent);
    }
    // Issue #550: wake the sweeper at this intent's deadline through the jobs
    // queue instead of relying on the legacy 30s poll.
    this.deadlines?.scheduleExpire(intent);
    // Creation is the entry edge of the funnel: the `vortex:intent:*` recording
    // rules count transitions *into* each state, so without this the intent
    // dashboard would start every conversion ratio from zero. `from_state` is
    // the sentinel "none" — an intent that does not exist yet has no state.
    this.countTransition(NONE_STATE, intent.state);
    await this.changed();
    return intent;
  }

  /**
   * Queues the settlement contract's `create_intent` call for `intent` on the
   * outbox (issue #396), for the unit-of-work path of {@link persistNewIntent}.
   * Nothing is broadcast here — the relay submits afterwards, so the request
   * never waits on Soroban and an Soroban outage cannot fail intent creation.
   */
  private async enqueueOnchain(outbox: IOutboxWriter, intent: Intent): Promise<void> {
    const contractId = this.configService.get("stellar.settlementContractId", { infer: true });
    if (!contractId) {
      throw new ServiceUnavailableException(
        "On-chain intent registration is enabled but SETTLEMENT_CONTRACT_ID is not configured",
      );
    }
    const entry = createIntentEntry(intent);
    // Validates the entry encodes to a contract call before it can become a
    // poison row.
    buildOutboxInvocation(entry, contractId);
    await outbox.enqueue(entry);
    this.logger.info("queued on-chain registration", { intentId: intent.intentId, chain: intent.srcChain });
  }

  /**
   * Does a write for `intent` need the settlement contract? Resolved from the
   * runtime rollout flag when the flag service is wired (issue #495), from
   * `ONCHAIN_INTENTS_ENABLED` otherwise — shared by creation and the later
   * accept/fill/cancel writes so they can never disagree about a rollout.
   */
  private async isOnchainWrite(intent: Intent): Promise<boolean> {
    if (this.flags) {
      return this.flags.getBooleanValue("onchain-intents-enabled", {
        targetingKey: intent.intentId,
        chain: intent.srcChain,
      });
    }
    return this.configService.get("onchainIntentsEnabled", { infer: true });
  }

  /**
   * Registers `intent` with the settlement contract, returning the broadcast
   * transaction hash (issue #385 — stamped as `pendingTxHash`). Only called
   * when ONCHAIN_INTENTS_ENABLED is on and no outbox unit of work is wired;
   * while that flag is off, create() stays fully in-memory (the rollout
   * fallback).
   */
  private async registerOnChain(intent: Intent): Promise<string> {
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
      this.logger.info("registered intent on-chain", { intentId: intent.intentId, txHash: result.hash });
      return result.hash;
    } catch (err) {
      this.logger.error("on-chain intent registration failed", { intentId: intent.intentId, err });
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

  // ---------------------------------------------------------------------------
  // Shadow-mode divergence monitoring (issue #401)
  // ---------------------------------------------------------------------------
  //
  // Every state transition the off-chain path commits is handed to
  // ShadowService, which simulates the equivalent contract call on a background
  // queue and records the (expected, simulated) pair. The call here is
  // synchronous, allocation-light and never awaited — see the latency
  // guarantee on ShadowService.observe.
  //
  // Both outcomes are reported, not just successes: a transition the off-chain
  // path *refused* is the interesting negative case, because a contract that
  // would have accepted it is a real divergence.

  /**
   * Report one off-chain transition to the shadow monitor.
   *
   * Callers MUST gate on {@link beginShadowObservation} first: that is where
   * the disabled check and the sampling draw happen, so a sampled-out
   * transition costs one `Math.random()` and no repository I/O, no XDR encoding
   * and no timer work.
   *
   * The whole body is wrapped: the monitor is observability, so a bug in it can
   * never surface as a failed intent transition.
   */
  private reportShadow(
    transition: ShadowTransition,
    intentId: string,
    committed: boolean,
    method: string,
    args: xdr.ScVal[],
  ): void {
    try {
      if (!this.shadowService) return;
      if (!isKnownShadowTransition(transition)) {
        // A mis-wired call site must be visible but must not throw into the
        // request path, and must not create an unbounded Prometheus label.
        this.logger.error("shadow observation dropped: unknown transition", { intentId, transition });
        return;
      }
      const request: ShadowObservationRequest = { transition, intentId, committed, method, args };
      this.shadowService.observe(request);
    } catch (err) {
      this.logger.error("shadow report failed", { intentId, transition, err });
    }
  }

  /**
   * Ask the shadow monitor whether it wants to observe the transition that is
   * about to happen, before any shadow-only work is done.
   *
   * Returns false when the monitor is absent, disabled, or has sampled this
   * transition out. Sampling happens here rather than inside `observe()` so
   * the extra repository read and XDR encoding the cancel/expire/slash hooks
   * need are only paid for transitions that will actually be simulated.
   */
  private beginShadowObservation(): boolean {
    try {
      return this.shadowService?.shouldObserve() === true;
    } catch (err) {
      this.logger.error("shadow shouldObserve failed", { err });
      return false;
    }
  }

  /**
   * Build the contract arguments for a transition, tolerating a record that
   * cannot be encoded.
   *
   * A malformed intent (a non-integer amount, an unparseable address) must not
   * be able to break the shadow path — the whole point of the monitor is to
   * gather evidence, and an encoding failure is evidence in itself. It is
   * therefore reported as an "empty" argument list, which simulates against the
   * contract's arity check and surfaces as an `outcome_mismatch`.
   */
  private safeArgs(build: () => xdr.ScVal[]): xdr.ScVal[] {
    try {
      return build();
    } catch (err) {
      this.logger.warn("shadow contract args could not be encoded", { err });
      return [];
    }
  }

  /**
   * Count one committed lifecycle transition (issue #481).
   *
   * `vortex_intent_state_transitions_total{from_state,to_state}` is the only
   * input to the `vortex:intent:*` recording rules, i.e. to the intent-funnel
   * dashboard and to the `VortexIntentsNotTerminating` /
   * `VortexSolverFillRateLow` alerts. It is counted here, once, immediately
   * after the conditional write won — the same place the state actually moves,
   * so a lost race is never counted.
   */
  private countTransition(from: string, to: string): void {
    try {
      this.metricsService?.incIntentStateTransition(from, to);
    } catch (err) {
      this.logger.error("intent transition metric failed", { fromState: from, toState: to, err });
    }
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
   * Count the number of intents standing for a user: `open` or `accepted`,
   * plus their `pending_open` / `pending_accepted` in-flight variants
   * (issue #385) — a chain write that has not confirmed yet still occupies
   * the user's {@link MAX_OPEN_INTENTS_PER_USER} slot.
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
      (i) =>
        i.state === "open" ||
        i.state === "accepted" ||
        i.state === "pending_open" ||
        i.state === "pending_accepted",
    ).length;
  }

  /**
   * Patch an intent without going through a lifecycle edge.
   *
   * Production callers only patch non-state fields (`quotedDstAmount`), which is
   * why this stays a plain repository call. A `state` in the patch is an
   * unconditional write that bypasses the guarded `*If*` methods, and therefore
   * also bypasses the funnel counters, the audit trail and the shadow monitor —
   * it is used by test setup only. It is logged so that a future production
   * caller is caught in review rather than silently skewing the dashboards.
   */
  async update(
    id: string,
    patch: Partial<Intent>,
    expectedVersion?: number,
  ): Promise<Intent | null> {
    if (patch.state !== undefined) {
      this.logger.warn("unguarded state patch bypasses transition observers", {
        intentId: id,
        toState: patch.state,
      });
    }
    const updated = written(await this.repo.update(id, patch, expectedVersion));
    if (updated) await this.changed();
    return updated;
  }

  /**
   * Re-read → mutate loop for writers for whom retrying is semantically safe
   * (the sweeper, quote persistence, deposit verification). `mutate` receives
   * the freshly-read intent and returns the versioned mutation to attempt, or
   * `undefined` when the intent no longer needs changing — which ends the loop
   * with `null`. Bounded by {@link MAX_VERSION_RETRIES}; if every attempt
   * conflicts, the last VersionConflict is returned.
   */
  async mutateWithRetry(
    id: string,
    mutate: (current: Intent) => Promise<MutationResult> | MutationResult | undefined,
    maxAttempts = MAX_VERSION_RETRIES,
  ): Promise<MutationResult> {
    let last: MutationResult = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = await this.repo.findById(id);
      if (!current) return null;
      const pending = mutate(current);
      if (pending === undefined) return null;
      last = await pending;
      if (!isVersionConflict(last)) {
        if (last !== null) await this.changed();
        return last;
      }
    }
    this.logger.warn("gave up after repeated version conflicts", { intentId: id, attempts: maxAttempts });
    return last;
  }

  /** Amend an open intent without changing its ID or creation history. */
  async amendIfOpen(
    id: string,
    patch: Pick<Intent, "minDstAmount" | "deadline">,
    now = Math.floor(Date.now() / 1000),
  ): Promise<Intent | null> {
    const amended = await this.repo.amendIfOpen(id, patch, now);
    if (amended) await this.changed();
    return amended;
  }

  /**
   * Atomically accept an intent only if it is currently "open" with a future
   * deadline (issue #473). Delegates to the repository so both in-memory and
   * Prisma adapters apply the conditional write atomically.
   *
   * The new deadline is set to now + fill window from governance params (or
   * CHAIN_FILL_WINDOW_DEFAULTS[srcChain] as fallback) so solvers on
   * slower-settling chains get a proportionally longer window and are not
   * unfairly slashed for a deadline that was never realistic.
   * Returns null when the intent is not found, not open, or past deadline.
   */
  async acceptIfOpen(
    id: string,
    solver: string,
    now?: number,
    ctx?: Partial<TransitionContext>,
  ): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const fillWindow =
      CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    const plan = transition({ intentId: id, state: "open" }, "accepted", { actor: solver, ...ctx });
    const updated = written(await this.repo.acceptIfOpen(id, solver, nowSec + fillWindow, nowSec));
    if (updated !== null) {
      this.recordTransition(plan, { deadline: updated.deadline });
      await this.changed();
      // Issue #550: the fill window is now the binding deadline — schedule the
      // fill-window job so the sweeper settles it through the jobs queue.
      this.deadlines?.scheduleFillWindow(updated);
    }
    if (this.beginShadowObservation()) {
      this.observeAccept(updated ?? intent, solver, updated !== null);
    }
    if (updated === null) return null;
    // Issue #385: with the onchain rollout on, the accept is not final until
    // the contract has seen it — broadcast and park pending_accepted.
    if (await this.isOnchainWrite(updated)) {
      return this.parkWithBroadcast(updated, "accept", () => [
        nativeToScVal(updated.intentId, { type: "string" }),
        new Address(updated.solver ?? solver).toScVal(),
        nativeToScVal(updated.deadline, { type: "u64" }),
      ]);
    }
    return updated;
  }

  /** Shadow hook for `accept` — reported whether or not the conditional write won. */
  private observeAccept(intent: Intent, solver: string, committed: boolean): void {
    this.reportShadow(
      "accept",
      intent.intentId,
      committed,
      "accept_intent",
      this.safeArgs(() => [
        nativeToScVal(intent.intentId, { type: "string" }),
        new Address(solver).toScVal(),
        nativeToScVal(intent.deadline, { type: "u64" }),
      ]),
    );
  }

  /**
   * Atomically fill an intent only if it is currently "accepted" by the given
   * solver with a future deadline (issue #473).
   * Returns null when the intent is not found, not accepted, assigned to a
   * different solver, or past the fill window (sweeper wins).
   */
  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
    now?: number,
    ctx?: Partial<TransitionContext>,
  ): Promise<Intent | null> {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const plan = transition({ intentId: id, state: "accepted" }, "filled", { actor: solver, ...ctx });
    const updated = written(
      await this.withFillRecord("filled", nowSec, (repo) => repo.fillIfAccepted(id, solver, patch, nowSec)),
    );
    if (updated !== null) {
      this.recordTransition(plan, { fillAmount: patch.fillAmount, txHash: patch.txHash });
      await this.changed();
    }
    if (this.beginShadowObservation()) {
      // Report from `patch` rather than re-reading: on a lost race the stored
      // record belongs to whoever won, so its fill amount is not the amount
      // this call was asked to settle. The submitted values are the ones the
      // contract would have been handed if the off-chain guard had not
      // pre-empted it.
      this.observeFill(id, solver, patch.fillAmount, patch.txHash, updated !== null);
    }
    if (updated === null) return null;
    // Issue #385: park the fill pending until the contract confirms it.
    if (await this.isOnchainWrite(updated)) {
      return this.parkWithBroadcast(updated, "fill", () => [
        nativeToScVal(updated.intentId, { type: "string" }),
        new Address(updated.solver ?? solver).toScVal(),
        nativeToScVal(BigInt(patch.fillAmount ?? "0"), { type: "i128" }),
        nativeToScVal(patch.txHash ?? "", { type: "string" }),
      ]);
    }
    return updated;
  }

  /**
   * Issue #427 — move a partial-fill intent to `filled` once its tranches
   * cover `srcAmount`, or when the user cancels the unfilled remainder of a
   * partially filled intent.
   *
   * Goes through the existing guarded edges — `acceptIfOpen` then
   * `fillIfAccepted` on the repository — rather than a new `open → filled`
   * edge, so the lifecycle table (and its TLA+ model) is unchanged and a
   * concurrent cancel / expiry still wins the first conditional write. Two
   * settlers racing (two final tranches confirming at once) resolve the same
   * way: one `acceptIfOpen` wins, the other gets `null`.
   *
   * The settlement-contract broadcast is skipped: the contract has no
   * partial-fill entrypoints (issue #427 keeps the on-chain path mocked
   * behind `PARTIAL_FILLS_ONCHAIN_ENABLED`).
   *
   * @returns the filled intent, or null when it was no longer open.
   */
  async settlePartialFill(
    id: string,
    solver: string,
    patch: Pick<Intent, "fillAmount" | "feeAmount" | "txHash" | "filledAt">,
    now: number,
  ): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const fillWindow = CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    const accepted = written(await this.repo.acceptIfOpen(id, solver, now + fillWindow, now));
    if (accepted === null) return null;
    this.countTransition("open", "accepted");
    const filled = written(await this.repo.fillIfAccepted(id, solver, patch, now));
    if (filled === null) {
      // Only reachable if something rewrote the row between the two guarded
      // writes; leave it accepted for the sweeper rather than force a state.
      this.logger.error("partial-fill settlement could not complete after accept", { intentId: id, solver });
      return null;
    }
    this.countTransition("accepted", "filled");
    return filled;
  }

  /** Shadow hook for `fill` — reported whether or not the conditional write won. */
  private observeFill(
    intentId: string,
    solver: string,
    fillAmount: string | undefined,
    txHash: string | undefined,
    committed: boolean,
  ): void {
    this.reportShadow(
      "fill",
      intentId,
      committed,
      "fill_intent",
      this.safeArgs(() => [
        nativeToScVal(intentId, { type: "string" }),
        new Address(solver).toScVal(),
        nativeToScVal(BigInt(fillAmount ?? "0"), { type: "i128" }),
        nativeToScVal(txHash ?? "", { type: "string" }),
      ]),
    );
  }

  /**
   * Atomically cancel an intent only if it is currently "open".
   * Returns null when the intent is not found or is not in the "open" state
   * (e.g. a concurrent accept() or sweeper expiry already transitioned it).
   */
  async cancelIfOpen(id: string, ctx?: Partial<TransitionContext>): Promise<Intent | null> {
    const plan = transition({ intentId: id, state: "open" }, "cancelled", { actor: "system", ...ctx });
    const updated = written(await this.repo.cancelIfOpen(id));
    if (updated !== null) {
      this.recordTransition(plan);
      await this.changed();
    }
    if (this.beginShadowObservation()) {
      const subject = updated ?? (await this.repo.findById(id));
      if (subject) {
        this.reportShadow(
          "cancel",
          subject.intentId,
          updated !== null,
          "cancel_intent",
          this.safeArgs(() => [
            nativeToScVal(subject.intentId, { type: "string" }),
            new Address(subject.user).toScVal(),
          ]),
        );
      }
    }
    if (updated === null) return null;
    // Issue #385: the cancellation is not final until the contract has seen
    // it — broadcast and park pending_cancelled.
    if (await this.isOnchainWrite(updated)) {
      return this.parkWithBroadcast(updated, "cancel", () => [
        nativeToScVal(updated.intentId, { type: "string" }),
        new Address(updated.user).toScVal(),
      ]);
    }
    return updated;
  }

  /**
   * Park an intent in the `pending_*` state matching `op` (issue #385).
   *
   * Parking is a confirmation marker, not a lifecycle edge: it records that
   * the guarded off-chain write for `op` has committed — and, when given, the
   * hash of its chain broadcast — while the settlement contract has not yet
   * confirmed it. It therefore writes the state directly rather than through
   * {@link canTransition}, because `filled → pending_filled` would otherwise
   * be an illegal edge out of a terminal state. {@link confirmIntent} settles
   * the marker back to the base state.
   *
   * @param intentId - Intent to park.
   * @param op - Chain write whose confirmation is being awaited.
   * @param txHash - Broadcast transaction hash, when one was obtained.
   * @returns The parked intent, or null when it does not exist.
   */
  async transitionToOnChainPending(
    id: string,
    op: PendingIntentOp,
    txHash?: string,
    ctx?: Partial<TransitionContext>,
  ): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const plan = transition(intent, PENDING_STATE_BY_OP[op], { actor: "system", ...ctx });
    const updated = written(
      await this.repo.transitionIf(id, plan.from, {
        state: plan.to,
        pendingOp: op,
        pendingTxHash: txHash,
      }),
    );
    if (updated !== null) {
      this.recordTransition(plan, { op, ...(txHash ? { txHash } : {}) });
      await this.changed();
    }
    return updated;
  }

  /**
   * Resolve a `pending_*` marker to its confirmed base state (issue #385),
   * clearing `pendingTxHash`/`pendingOp`.
   *
   * @param intentId - Intent whose in-flight write has been observed on chain.
   * @returns The confirmed intent, or null when it does not exist or is not
   *   in a pending state — confirmation only means something for a write that
   *   is actually in flight.
   */
  async confirmIntent(id: string, ctx?: Partial<TransitionContext>): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const confirmed = CONFIRMED_STATE_BY_PENDING[intent.state];
    if (!confirmed) return null;
    const plan = transition(intent, confirmed, { actor: "system", ...ctx });
    const updated = written(
      await this.repo.transitionIf(id, plan.from, {
        state: confirmed,
        pendingTxHash: undefined,
        pendingOp: undefined,
      }),
    );
    if (updated !== null) {
      this.recordTransition(plan, intent.pendingTxHash ? { txHash: intent.pendingTxHash } : {});
      await this.changed();
    }
    return updated;
  }

  /**
   * Roll a slash back (issue #397 saga, issue #406 compensation edge): move a
   * `slashed` intent to `filled` (the fill landed after all) or `expired` (the
   * slash could not be submitted). These edges leave a terminal state, so the
   * plan and the write both carry the explicit override.
   *
   * @returns The compensated intent, or null when it is absent or no longer
   *   `slashed` (nothing to roll back).
   */
  async compensateSlash(
    id: string,
    to: "filled" | "expired",
    ctx: TransitionContext,
    patch: Pick<Partial<Intent>, "txHash"> = {},
    now = Math.floor(Date.now() / 1000),
  ): Promise<Intent | null> {
    const run = async (
      repo: IIntentsRepository,
      fills?: { record: (f: SolverFillRecord) => Promise<void> },
    ): Promise<{ updated: Intent | null; plan?: TransitionPlan }> => {
      const intent = await repo.findById(id);
      if (!intent || intent.state !== "slashed") return { updated: null };
      const plan = transition(intent, to, { ...ctx, override: true });
      const updated = written(
        await repo.transitionIf(id, "slashed", { ...patch, state: to }, { override: true }),
      );
      if (updated && fills && intent.solver) {
        const failure = await this.buildFillRecord(intent, "failed", now);
        await fills.record({ ...failure, outcome: "reversed" });
        if (to === "filled") await fills.record(await this.buildFillRecord(updated, "filled", now));
      }
      return { updated, plan };
    };
    const { updated, plan } = this.fillLedger
      ? await this.fillLedger.run(({ intents, fills }) => run(intents, fills))
      : await run(this.repo);
    if (updated !== null && plan) {
      this.recordTransition(plan);
      await this.changed();
    }
    return updated;
  }

  /**
   * Issue #385: attempt the settlement-contract broadcast for a committed
   * write, then park the intent in its `pending_*` state.
   *
   * The park is unconditional — with the onchain rollout on, the base state
   * is never claimed final — while the broadcast is best-effort: argument
   * encoding (a malformed address) or an RPC failure logs and parks without
   * a hash instead of failing a write that has already committed. Settling
   * the marker is {@link confirmIntent}'s job.
   */
  private async parkWithBroadcast(
    intent: Intent,
    op: PendingIntentOp,
    buildArgs: () => xdr.ScVal[],
  ): Promise<Intent> {
    let txHash: string | undefined;
    try {
      const contractId = this.configService.get("stellar.settlementContractId", { infer: true });
      if (!contractId) throw new Error("SETTLEMENT_CONTRACT_ID is not configured");
      const result = await this.stellarTxService.invokeContract({
        contractId,
        method: ONCHAIN_METHOD_BY_OP[op],
        args: buildArgs(),
      });
      txHash = result.hash;
    } catch (err) {
      this.logger.error("on-chain broadcast failed; parked pending without tx hash", {
        intentId: intent.intentId,
        op,
        err,
      });
    }
    return (await this.transitionToOnChainPending(intent.intentId, op, txHash)) ?? intent;
  }

  /**
   * Atomically expire an intent only if it is currently "open".
   * Used by the sweeper so a concurrent user cancel() or solver accept()
   * always wins the race.
   */
  async expireIfOpen(id: string, ctx?: Partial<TransitionContext>): Promise<Intent | null> {
    const plan = transition({ intentId: id, state: "open" }, "expired", { actor: "system", ...ctx });
    const updated = written(await this.repo.expireIfOpen(id));
    if (updated !== null) {
      this.recordTransition(plan, { deadline: updated.deadline });
      await this.changed();
    }
    if (this.beginShadowObservation()) {
      const subject = updated ?? (await this.repo.findById(id));
      if (subject) {
        this.reportShadow(
          "expire",
          subject.intentId,
          updated !== null,
          "expire_intent",
          this.safeArgs(() => [
            nativeToScVal(subject.intentId, { type: "string" }),
            nativeToScVal(subject.deadline, { type: "u64" }),
          ]),
        );
      }
    }
    return updated;
  }

  /**
   * Atomically slash an intent only if it is currently "accepted".
   * Used by the sweeper so a concurrent solver fill() always wins the race.
   */
  async slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    ctx?: Partial<TransitionContext>,
  ): Promise<Intent | null> {
    const plan = transition({ intentId: id, state: "accepted" }, "slashed", {
      actor: "system",
      reason: patch.slashReason,
      ...ctx,
    });
    const updated = written(
      await this.withFillRecord("failed", patch.slashedAt, (repo) => repo.slashIfAccepted(id, patch)),
    );
    if (updated !== null) {
      this.recordTransition(plan, { solver: updated.solver, slashedAt: patch.slashedAt });
      await this.changed();
    }
    if (this.beginShadowObservation()) {
      const subject = updated ?? (await this.repo.findById(id));
      // An "accepted" intent always carries a solver. A record without one is
      // corrupt, so skip the simulation rather than encoding a null address —
      // the sweep loop already logs that case loudly.
      const slashedSolver = subject?.solver;
      if (subject && slashedSolver) {
        this.reportShadow(
          "slash",
          subject.intentId,
          updated !== null,
          "slash_intent",
          this.safeArgs(() => [
            nativeToScVal(subject.intentId, { type: "string" }),
            new Address(slashedSolver).toScVal(),
            nativeToScVal(patch.slashReason, { type: "string" }),
            nativeToScVal(patch.slashedAt, { type: "u64" }),
          ]),
        );
      }
    }
    return updated;
  }

  /**
   * Issue #477 — extend an accepted intent's fill window, used by the sweeper
   * while an emergency pause blocks fills so the solver is not slashed for a
   * pause it did not cause. Returns null when the intent is no longer accepted
   * or already has a later deadline.
   */
  async extendDeadlineIfAccepted(id: string, newDeadline: number): Promise<Intent | null> {
    const updated = written(await this.repo.extendDeadlineIfAccepted(id, newDeadline));
    if (updated) this.deadlines?.scheduleFillWindow(updated);
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
    this.writeAudit(intentId, {
      timestamp: new Date().toISOString(),
      toState,
      actor,
      reason,
      ...(metadata ? { metadata } : {}),
    });
  }

  /**
   * Apply the common side effects of a persisted transition plan (issue
   * #406): the funnel counter and the audit entry. Called once, right after
   * the conditional write won. `extra` adds write-time details (the new
   * deadline, the fill amount, …) to the audit metadata; undefined values are
   * dropped and caller-supplied metadata wins on a key clash.
   */
  private recordTransition(plan: TransitionPlan, extra: Record<string, unknown> = {}): void {
    this.countTransition(plan.from, plan.to);
    const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    this.writeAudit(plan.intentId, {
      ...plan.audit,
      metadata: { ...defined, ...plan.audit.metadata },
    });
  }

  /** In-memory + persistent audit write shared by every audit path. */
  private writeAudit(intentId: string, entry: IntentAuditEntry): void {
    const { toState, actor, reason, metadata } = entry;
    // Issue #488: one queryable record per audited transition.
    this.logger.info("intent transition", {
      event: LOG_EVENTS.INTENT_TRANSITION,
      intentId,
      toState,
      actor,
      reason,
    });

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
        this.logger.error("intent audit entry persist failed", { intentId, toState, actor, err });
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
  /**
   * Audit trail for the `GET /intents/:id/audit` endpoint: the in-memory log
   * when this replica holds entries for the intent, otherwise the persisted
   * `intent_audit_log` rows (after a restart, or when another replica wrote
   * them).
   *
   * The persisted query bounds `timestamp` from below by the intent's creation
   * time (minus {@link AUDIT_CLOCK_SKEW_SECONDS}), so on the monthly-
   * partitioned table (issue #407) PostgreSQL prunes every partition older
   * than the intent instead of probing each partition's index.
   */
  async getAuditTrail(
    intent: Pick<Intent, "intentId" | "createdAt">,
    limit: number,
    offset: number,
  ): Promise<{ entries: IntentAuditEntry[]; total: number }> {
    const inMemory = this.auditLog.get(intent.intentId) ?? [];
    if (inMemory.length > 0) {
      return { entries: this.getAuditLog(intent.intentId, limit, offset), total: inMemory.length };
    }
    const audit = (this.prisma as unknown as {
      intentAuditLog?: {
        findMany?: (args: unknown) => Promise<
          Array<{ timestamp: Date; toState: string; actor: string; reason: string; metadata: unknown }>
        >;
        count?: (args: unknown) => Promise<number>;
      };
    }).intentAuditLog;
    if (typeof audit?.findMany !== "function") return { entries: [], total: 0 };
    const where = {
      intentId: intent.intentId,
      timestamp: { gte: new Date((intent.createdAt - AUDIT_CLOCK_SKEW_SECONDS) * 1000) },
    };
    try {
      const [rows, total] = await Promise.all([
        audit.findMany({
          where,
          orderBy: [{ timestamp: "asc" }, { id: "asc" }],
          skip: Math.max(0, offset),
          take: Math.min(limit, 100),
        }),
        typeof audit.count === "function" ? audit.count({ where }) : Promise.resolve(undefined),
      ]);
      const entries: IntentAuditEntry[] = rows.map((r) => ({
        timestamp: r.timestamp.toISOString(),
        toState: r.toState as IntentState,
        actor: r.actor,
        reason: r.reason,
        ...(r.metadata ? { metadata: r.metadata as Record<string, unknown> } : {}),
      }));
      return { entries, total: total ?? entries.length };
    } catch (err) {
      this.logger.warn(`[audit] persisted read failed for intent ${intent.intentId}: ${(err as Error).message}`);
      return { entries: [], total: 0 };
    }
  }

  getAuditLog(intentId: string, limit?: number, offset?: number): IntentAuditEntry[] {
    const entries = this.auditLog.get(intentId) ?? [];
    if (limit === undefined && offset === undefined) return entries;

    const safeLimit = Math.min(limit ?? 20, 100);
    const safeOffset = Math.max(0, offset ?? 0);
    return entries.slice(safeOffset, safeOffset + safeLimit);
  }
}
