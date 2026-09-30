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
import { ShadowService, type ShadowObservationRequest } from "../soroban/shadow.service";
import { SHADOW_TRANSITIONS, type ShadowTransition } from "../soroban/shadow.types";
import { MetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProtocolParamsService } from "../governance/params.service";
import { FeatureFlagService } from "../flags/feature-flag.service";
import { IntentDeadlineScheduler } from "./intents-deadline.jobs";

const TERMINAL_STATES: IntentState[] = ["filled", "cancelled", "expired", "slashed"];

/**
 * Sentinel `from_state` for the transition into "open".
 *
 * Not an {@link IntentState}: creation has no prior state, and inventing one
 * would put a value in the `from_state` label that no lifecycle edge can
 * produce. Bounded (one extra series), and it keeps the funnel's denominator
 * honest.
 */
const NONE_STATE = "none";

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
    @Optional() private readonly deadlines?: IntentDeadlineScheduler,
  ) {}

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
   * Build, optionally register on-chain, and persist a brand-new intent.
   * Contains no idempotency logic — deduplication is the caller's concern.
   */
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
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: defaultDeadline,
      paramsVersion: paramsSnapshot.version,
    };

    // ONCHAIN_INTENTS_ENABLED is the default; the `onchain-intents-enabled`
    // runtime flag (issue #495) can roll it out per chain / percentage.
    const onchain = this.flags
      ? await this.flags.getBooleanValue("onchain-intents-enabled", {
          targetingKey: intent.intentId,
          chain: intent.srcChain,
        })
      : this.configService.get("onchainIntentsEnabled", { infer: true });
    if (onchain) {
      await this.registerOnChain(intent);
    }

    await this.repo.save(intent);
    this.deadlines?.scheduleExpire(intent);
    // Creation is the entry edge of the funnel: the `vortex:intent:*` recording
    // rules count transitions *into* each state, so without this the intent
    // dashboard would start every conversion ratio from zero. `from_state` is
    // the sentinel "none" — an intent that does not exist yet has no state.
    this.countTransition(NONE_STATE, "open");
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
  async update(id: string, patch: Partial<Intent>): Promise<Intent | null> {
    if (patch.state !== undefined) {
      this.logger.warn(
        `[state-machine] update(${id}) carries a state patch ("${patch.state}"); ` +
          `this bypasses the guarded transitions and their observers`,
      );
    }
    return this.repo.update(id, patch);
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
    const updated = await this.repo.acceptIfOpen(id, solver, nowSec + fillWindow, nowSec);
    if (updated !== null) {
      this.countTransition("open", "accepted");
      this.deadlines?.scheduleFillWindow(updated);
    }
    if (this.beginShadowObservation()) {
      this.observeAccept(updated ?? intent, solver, updated !== null);
    }
    return updated;
  }

  /** Accept only when this solver remains below the configured exposure cap. */
  async acceptIfOpenWithinExposure(
    id: string,
    solver: string,
    candidateExposureUsdMicros: bigint,
    maxExposureUsdMicros: bigint,
    now = Math.floor(Date.now() / 1000),
  ): Promise<{ intent: Intent | null; exposureExceeded: boolean }> {
    const intent = await this.repo.findById(id);
    if (!intent) return { intent: null, exposureExceeded: false };
    const fillWindow = this.protocolParamsService.snapshotForChain(intent.srcChain).fillWindowSeconds;
    const result = await this.repo.acceptIfOpenWithinExposure(
      id,
      solver,
      now + fillWindow,
      now,
      candidateExposureUsdMicros,
      maxExposureUsdMicros,
    );
    if (result.intent !== null) this.countTransition("open", "accepted");
    if (this.beginShadowObservation()) {
      this.observeAccept(result.intent ?? intent, solver, result.intent !== null);
    }
    return result;
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
    const updated = await this.repo.fillIfAccepted(id, solver, patch, nowSec);
    if (updated !== null) this.countTransition("accepted", "filled");
    if (this.beginShadowObservation()) {
      // Report from `patch` rather than re-reading: on a lost race the stored
      // record belongs to whoever won, so its fill amount is not the amount
      // this call was asked to settle. The submitted values are the ones the
      // contract would have been handed if the off-chain guard had not
      // pre-empted it.
      this.observeFill(id, solver, patch.fillAmount, patch.txHash, updated !== null);
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
    const updated = await this.repo.cancelIfOpen(id);
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
    return updated;
  }

  /**
   * Atomically expire an intent only if it is currently "open".
   * Used by the sweeper so a concurrent user cancel() or solver accept()
   * always wins the race.
   */
  async expireIfOpen(id: string): Promise<Intent | null> {
    const updated = await this.repo.expireIfOpen(id);
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
    const updated = await this.repo.slashIfAccepted(id, patch);
    if (updated !== null) this.countTransition("accepted", "slashed");
    if (this.beginShadowObservation()) {
      const subject = updated ?? (await this.repo.findById(id));
      // An "accepted" intent always carries a solver. A record without one is
      // corrupt, so skip the simulation rather than encoding a null address —
      // the sweep loop already logs that case loudly.
      if (subject?.solver) {
        const solver = subject.solver;
        this.reportShadow(
          "slash",
          subject.intentId,
          updated !== null,
          "slash_intent",
          this.safeArgs(() => [
            nativeToScVal(subject.intentId, { type: "string" }),
            new Address(solver).toScVal(),
            nativeToScVal(patch.slashReason ?? "", { type: "string" }),
            nativeToScVal(patch.slashedAt ?? 0, { type: "u64" }),
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
    const updated = await this.repo.extendDeadlineIfAccepted(id, newDeadline);
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
