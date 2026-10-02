import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Intent, IntentAuditEntry, IntentState, PendingIntentOp } from "./intents.types";
import { INTENTS_REPOSITORY, IIntentsRepository, isVersionConflict, MutationResult } from "./intents.repository";
import { INTENTS_UNIT_OF_WORK, IIntentsUnitOfWork } from "./intents.unit-of-work";
import { IntentDeadlineScheduler } from "./intents-deadline.jobs";
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
  ) {}

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
    this.logger.log(`Queued on-chain registration for intent ${intent.intentId}`);
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
      this.logger.log(`Registered intent ${intent.intentId} on-chain (tx ${result.hash})`);
      return result.hash;
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
        this.logger.error(`[shadow] dropping observation with unknown transition "${transition}"`);
        return;
      }
      const request: ShadowObservationRequest = { transition, intentId, committed, method, args };
      this.shadowService.observe(request);
    } catch (err) {
      this.logger.error(`[shadow] reportShadow failed, discarding: ${(err as Error).message}`);
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
      this.logger.error(`[shadow] shouldObserve failed: ${(err as Error).message}`);
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
      this.logger.warn(
        `[shadow] could not encode contract args for simulation: ${(err as Error).message}`,
      );
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
      this.logger.error(`[metrics] could not record transition ${from}->${to}: ${(err as Error).message}`);
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
      this.logger.warn(
        `[state-machine] update(${id}) carries a state patch ("${patch.state}"); ` +
          `this bypasses the guarded transitions and their observers`,
      );
    }
    return written(await this.repo.update(id, patch, expectedVersion));
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
      if (!isVersionConflict(last)) return last;
    }
    this.logger.warn(`[occ] gave up on intent ${id} after ${maxAttempts} version conflicts`);
    return last;
  }

  /** Amend an open intent without changing its ID or creation history. */
  async amendIfOpen(
    id: string,
    patch: Pick<Intent, "minDstAmount" | "deadline">,
    now = Math.floor(Date.now() / 1000),
  ): Promise<Intent | null> {
    return this.repo.amendIfOpen(id, patch, now);
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
  async acceptIfOpen(id: string, solver: string, now?: number): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const fillWindow =
      CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    const updated = written(await this.repo.acceptIfOpen(id, solver, nowSec + fillWindow, nowSec));
    if (updated !== null) {
      this.countTransition("open", "accepted");
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
  ): Promise<Intent | null> {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const updated = written(await this.repo.fillIfAccepted(id, solver, patch, nowSec));
    if (updated !== null) this.countTransition("accepted", "filled");
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
  async cancelIfOpen(id: string): Promise<Intent | null> {
    const updated = written(await this.repo.cancelIfOpen(id));
    if (updated !== null) this.countTransition("open", "cancelled");
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
  ): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const updated = written(
      await this.repo.update(id, {
        state: PENDING_STATE_BY_OP[op],
        pendingOp: op,
        pendingTxHash: txHash,
      }),
    );
    if (updated !== null) this.countTransition(intent.state, updated.state);
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
  async confirmIntent(id: string): Promise<Intent | null> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const confirmed = CONFIRMED_STATE_BY_PENDING[intent.state];
    if (!confirmed) return null;
    const updated = written(
      await this.repo.update(id, {
        state: confirmed,
        pendingTxHash: undefined,
        pendingOp: undefined,
      }),
    );
    if (updated !== null) this.countTransition(intent.state, confirmed);
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
      this.logger.error(
        `On-chain ${op} broadcast failed for intent ${intent.intentId}: ` +
          `${(err as Error).message} — parked pending without a tx hash`,
      );
    }
    return (await this.transitionToOnChainPending(intent.intentId, op, txHash)) ?? intent;
  }

  /**
   * Atomically expire an intent only if it is currently "open".
   * Used by the sweeper so a concurrent user cancel() or solver accept()
   * always wins the race.
   */
  async expireIfOpen(id: string): Promise<Intent | null> {
    const updated = written(await this.repo.expireIfOpen(id));
    if (updated !== null) this.countTransition("open", "expired");
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
  ): Promise<Intent | null> {
    const updated = written(await this.repo.slashIfAccepted(id, patch));
    if (updated !== null) this.countTransition("accepted", "slashed");
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
