import { HttpException, HttpStatus, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";

/**
 * Escalation tier applied to a solver that repeatedly accepts intents it never
 * fills (issue #453).
 *
 * ```
 * 0 → no control
 * 1 → cooldown   (accepts refused until cooldownUntil)
 * 2 → concurrency cap (level-1 cooldown *plus* at most ANTIGRIEFING_CONCURRENCY_CAP
 *                      concurrently accepted intents)
 * 3 → suspension (accepts refused until the suspension lapses or an operator clears it)
 * ```
 *
 * Tiers only ever move one step at a time, and only while the solver's rolling
 * unfilled-accept ratio is at or above the configured threshold.
 */
export type AntiGriefingLevel = 0 | 1 | 2 | 3;

/**
 * Machine-readable error codes returned by the accept path when an
 * anti-griefing control refuses the request. Clients may branch on `code`;
 * the human-readable `error` field is the same information in prose.
 */
export type AntiGriefingErrorCode =
  | "ANTIGRIEFING_COOLDOWN"
  | "ANTIGRIEFING_CONCURRENCY_LIMIT"
  | "ANTIGRIEFING_SUSPENDED";

/** Everything the controller needs to explain *why* an accept was refused. */
export class AntiGriefingException extends HttpException {
  /**
   * Read by the global exception filter to emit a `Retry-After` header.
   * Deliberately kept off the JSON body so the response shape stays stable.
   */
  readonly retryAfterSeconds?: number;

  readonly code: AntiGriefingErrorCode;

  constructor(params: {
    code: AntiGriefingErrorCode;
    error: string;
    status: HttpStatus;
    retryAfterSeconds?: number;
    details: Record<string, unknown>;
  }) {
    // The body must carry a top-level `error` string and must *not* carry
    // `statusCode`: HttpExceptionFilter passes custom-shaped bodies through
    // untouched only when both hold, so every field below survives to the
    // client instead of being collapsed into `{ error: message }`.
    super({ error: params.error, code: params.code, ...params.details }, params.status);
    this.code = params.code;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.name = "AntiGriefingException";
  }
}

/** One accept whose fill window has been resolved (issue #453). */
export interface GriefOutcome {
  /** When the outcome was resolved, in epoch **milliseconds**. */
  at: number;
  intentId: string;
  /** Source chain of the intent — used for incident exclusions. */
  chain: string;
  /** "filled" = the solver delivered; "unfilled" = the intent was slashed. */
  outcome: "filled" | "unfilled";
}

/** An admin-declared incident window during which failures are not counted. */
export interface AntiGriefingIncident {
  /** Stable id, e.g. `incident-3`. */
  id: string;
  /** Source chain the incident covers, or `null` for every chain. */
  chain: string | null;
  reason: string;
  /** Admin principal id, or "system". */
  actor: string;
  /** Incident opened, epoch ms. */
  startedAt: number;
  /** Incident closed, epoch ms — `null` while it is still open. */
  endedAt: number | null;
  /**
   * Failures up to this instant are still excused after the incident closes.
   *
   * Slashing is detected by the sweeper, which can run well after an outage
   * ends, so an operator may extend coverage when closing an incident.
   * Defaults to `endedAt`.
   */
  excludeUntil: number | null;
}

/** What happened, for the audit trail. */
export type AntiGriefingAuditAction =
  | "cooldown"
  | "concurrency_cap"
  | "suspended"
  | "recovered"
  | "blocked"
  | "incident_opened"
  | "incident_closed"
  | "incident_excluded"
  | "manual_reset";

/** One audited anti-griefing action (issue #453: *all* actions are audited). */
export interface AntiGriefingAuditEntry {
  /** Monotonic id so a client can page through the trail. */
  id: number;
  timestamp: number;
  /** Solver the action concerns; `null` for incident management entries. */
  solver: string | null;
  action: AntiGriefingAuditAction;
  level: AntiGriefingLevel;
  /** Rolling unfilled ratio at the moment of the action, in `[0, 1]`. */
  ratio: number;
  intentId?: string;
  chain?: string;
  reason: string;
  actor?: string;
}

/** Per-solver view of the controls — what the dashboard and solvers see. */
export interface AntiGriefingStatus {
  solver: string;
  enabled: boolean;
  level: AntiGriefingLevel;
  /** Resolved accepts inside the rolling window. */
  samples: number;
  filled: number;
  unfilled: number;
  /** `unfilled / samples`, or `0` when the window is empty. */
  unfilledRatio: number;
  /** Epoch ms until which accepts are refused, or `null` when not cooling down. */
  cooldownUntil: number | null;
  suspended: boolean;
  /** Epoch ms at which the suspension lapses; `null` when indefinite or absent. */
  suspendedUntil: number | null;
  /** Concurrency cap in force, or `null` when the solver is uncapped. */
  concurrencyCap: number | null;
  /** Multiplier applied to the solver's leaderboard reputation score. */
  reputationPenalty: number;
  windowSeconds: number;
  minSamples: number;
  thresholdRatio: number;
}

/** Result of {@link AntiGriefingService.recordOutcome}. */
export interface RecordOutcomeResult {
  /** False when the outcome was a duplicate or the controls are disabled. */
  recorded: boolean;
  /** True when an admin incident excused this failure. */
  excluded: boolean;
  level: AntiGriefingLevel;
  unfilledRatio: number;
}

/** Reputational cost of each tier, applied to leaderboard/stats scores. */
const REPUTATION_PENALTY_BY_LEVEL: Record<AntiGriefingLevel, number> = {
  0: 1,
  1: 0.9,
  2: 0.7,
  3: 0.5,
};

/**
 * Bounds on the in-process state. The controls are deliberately
 * per-replica (a single replica is the accept critical section), so the maps
 * must not be allowed to grow with traffic.
 */
const MAX_OUTCOMES_PER_SOLVER = 1_000;
const MAX_TRACKED_SOLVERS = 5_000;
const MAX_AUDIT_ENTRIES = 1_000;
const MAX_INCIDENTS = 200;

/**
 * Anti-griefing controls for accept-without-fill behaviour (issue #453).
 *
 * A griefing solver accepts intents it never fills, locking user funds for the
 * whole fill window while paying at most one slash per intent. This service is
 * the pre-slash control: a *policy engine* evaluated in the accept critical
 * section (see {@link assertCanAccept}) that limits the blast radius before the
 * on-chain slash is ever reached.
 *
 * Detection is a rolling per-solver ratio of unfilled accepts:
 *
 * ```
 * ratio = unfilled / (filled + unfilled)   over ANTIGRIEFING_WINDOW_SECONDS
 * ```
 *
 * Once `ratio >= ANTIGRIEFING_RATIO_THRESHOLD` (with at least
 * `ANTIGRIEFING_MIN_SAMPLES` resolved accepts) the solver is escalated one tier
 * per subsequent breach — cooldown, then concurrency cap, then suspension. A
 * solver whose ratio falls back to `ANTIGRIEFING_RECOVERY_RATIO` steps down one
 * tier, so an honest solver that had a bad streak is not punished forever.
 *
 * Failures that coincide with an admin-declared chain incident are never
 * counted, so a genuine chain outage cannot be mistaken for griefing.
 *
 * State is in-process and intentionally simple: the accept path is a single
 * hot critical section and the controls degrade to "no control" (never to
 * "blocks everybody") if the process restarts. Cross-replica consistency is
 * out of scope for #453 — each replica sees the accepts it served.
 */
@Injectable()
export class AntiGriefingService {
  private readonly logger = new Logger(AntiGriefingService.name);

  private readonly states = new Map<string, SolverGriefState>();
  private readonly incidents = new Map<string, AntiGriefingIncident>();
  private readonly audit: AntiGriefingAuditEntry[] = [];

  private incidentSeq = 0;
  private auditSeq = 0;

  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly thresholdRatio: number;
  private readonly recoveryRatio: number;
  private readonly cooldownMs: number;
  private readonly concurrencyCap: number;
  /** Suspension length in ms; `0` means "until an operator clears it". */
  private readonly suspensionMs: number;

  constructor(
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const cfg = config.get("antiGriefing", { infer: true });
    this.enabled = cfg.enabled;
    this.windowMs = cfg.windowSeconds * 1000;
    this.minSamples = cfg.minSamples;
    this.thresholdRatio = cfg.thresholdRatio;
    // If misconfigured (recovery >= threshold) escalation simply wins because
    // it is evaluated first — the tiers can never oscillate.
    this.recoveryRatio = Math.min(cfg.recoveryRatio, cfg.thresholdRatio);
    this.cooldownMs = cfg.cooldownSeconds * 1000;
    this.concurrencyCap = cfg.concurrencyCap;
    this.suspensionMs = cfg.suspensionSeconds * 1000;
  }

  // ── Accept-path enforcement ────────────────────────────────────────────────

  /**
   * Decide whether `solver` may accept another intent (issue #453).
   *
   * Called from the accept critical section *before* the atomic
   * `acceptIfOpen` write, so a refused accept never mutates intent state.
   *
   * @param solver  Solver address being refused or admitted.
   * @param ctx.intentId  Intent being accepted (for the audit trail).
   * @param ctx.openAccepts  Lazily resolves the number of intents currently in
   *   `accepted` state for this solver (from
   *   `IntentsService.getAcceptedCountBySolver`), so the concurrency cap counts
   *   real, atomic intent state rather than a local approximation. It is only
   *   awaited on the tier-2+ path, so an unpunished solver never pays for the
   *   scan.
   * @throws {AntiGriefingException} 429 `ANTIGRIEFING_COOLDOWN`,
   *   429 `ANTIGRIEFING_CONCURRENCY_LIMIT` or 403 `ANTIGRIEFING_SUSPENDED`.
   */
  async assertCanAccept(
    solver: string,
    ctx: { intentId: string; openAccepts: () => Promise<number> },
  ): Promise<void> {
    if (!this.enabled) return;

    const now = this.now();
    const state = this.getState(solver);
    this.refreshSuspension(state, now);

    if (state.suspended) {
      const until = state.suspendedUntil;
      const retryAfterSeconds =
        until === null ? undefined : Math.max(1, Math.ceil((until - now) / 1000));
      const details: Record<string, unknown> = {
        solver,
        intentId: ctx.intentId,
        level: state.level,
        suspendedUntil: until,
        // `null` means indefinite — only an operator can lift it — so there is
        // no useful Retry-After and none is advertised.
        indefinite: until === null,
      };
      this.auditBlocked(solver, "ANTIGRIEFING_SUSPENDED", state, ctx.intentId, details);
      this.metrics?.incAntiGriefingBlocked("ANTIGRIEFING_SUSPENDED");
      throw new AntiGriefingException({
        code: "ANTIGRIEFING_SUSPENDED",
        error: "Solver is suspended by anti-griefing controls",
        status: HttpStatus.FORBIDDEN,
        retryAfterSeconds,
        details: { ...details, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
      });
    }

    if (state.cooldownUntil !== null && state.cooldownUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000));
      const details = {
        solver,
        intentId: ctx.intentId,
        level: state.level,
        cooldownUntil: state.cooldownUntil,
        retryAfterSeconds,
      };
      this.auditBlocked(solver, "ANTIGRIEFING_COOLDOWN", state, ctx.intentId, details);
      this.metrics?.incAntiGriefingBlocked("ANTIGRIEFING_COOLDOWN");
      throw new AntiGriefingException({
        code: "ANTIGRIEFING_COOLDOWN",
        error: "Solver is cooling down after repeated accept-without-fill behaviour",
        status: HttpStatus.TOO_MANY_REQUESTS,
        retryAfterSeconds,
        details,
      });
    }

    // Tier 2+: the concurrency cap. This is the only branch that needs real
    // intent state, so the (scanning) count is resolved here and nowhere else.
    if (state.level >= 2) {
      const openAccepts = await ctx.openAccepts();
      if (openAccepts < this.concurrencyCap) return;

      const details = {
        solver,
        intentId: ctx.intentId,
        level: state.level,
        openAccepts,
        concurrencyCap: this.concurrencyCap,
      };
      this.auditBlocked(solver, "ANTIGRIEFING_CONCURRENCY_LIMIT", state, ctx.intentId, details);
      this.metrics?.incAntiGriefingBlocked("ANTIGRIEFING_CONCURRENCY_LIMIT");
      throw new AntiGriefingException({
        code: "ANTIGRIEFING_CONCURRENCY_LIMIT",
        error: "Solver has reached its reduced concurrent-accept limit",
        status: HttpStatus.TOO_MANY_REQUESTS,
        details,
      });
    }
  }

  // ── Outcome ingestion ──────────────────────────────────────────────────────

  /**
   * Record that an accepted intent for `solver` was filled or missed its fill
   * window, then re-evaluate the rolling ratio.
   *
   * Callers: `IntentsController.fill` (`"filled"`) and
   * `IntentsSweeperService.slashMissedFill` (`"unfilled"`).
   *
   * Unfilled outcomes that fall inside an admin incident are dropped from the
   * window and audited as `incident_excluded`, so a chain outage cannot push an
   * honest solver over the threshold.
   *
   * @param params.at Optional resolution time in epoch **ms** (defaults to now)
   *   — the sweeper passes the moment it slashed so replayed/delayed sweeps
   *   still land in the right window.
   * @returns Whether the outcome was counted, plus the resulting tier.
   */
  recordOutcome(
    solver: string,
    params: { intentId: string; chain: string; outcome: "filled" | "unfilled"; at?: number },
  ): RecordOutcomeResult {
    const now = this.now();
    const at = params.at ?? now;

    if (!this.enabled) {
      return { recorded: false, excluded: false, level: 0, unfilledRatio: 0 };
    }

    if (params.outcome === "unfilled" && this.isIncidentCovering(params.chain, at)) {
      this.metrics?.incAntiGriefingIncidentExcluded();
      this.pushAudit({
        solver,
        action: "incident_excluded",
        level: 0,
        ratio: 0,
        intentId: params.intentId,
        chain: params.chain,
        reason: "failure occurred during an admin-declared incident and was not counted",
      });
      const status = this.getStatus(solver);
      return {
        recorded: false,
        excluded: true,
        level: status.level,
        unfilledRatio: status.unfilledRatio,
      };
    }

    const state = this.getState(solver);
    this.refreshSuspension(state, now);
    if (state.outcomes.some((o) => o.intentId === params.intentId)) {
      // The sweeper and the fill route can both resolve the same intent.
      const status = this.getStatus(solver);
      return {
        recorded: false,
        excluded: false,
        level: status.level,
        unfilledRatio: status.unfilledRatio,
      };
    }

    state.outcomes.push({
      at,
      intentId: params.intentId,
      chain: params.chain,
      outcome: params.outcome,
    });
    this.pruneOutcomes(state, now);

    const { samples, ratio } = this.evaluate(state, now);
    this.metrics?.setAntiGriefingRatio(solver, ratio);

    if (samples >= this.minSamples && ratio >= this.thresholdRatio && this.canEscalate(state, now)) {
      this.escalate(solver, state, ratio, params.intentId, params.chain);
    } else if (samples >= this.minSamples && ratio <= this.recoveryRatio && state.level > 0) {
      this.recover(solver, state, ratio);
    }

    return { recorded: true, excluded: false, level: state.level, unfilledRatio: ratio };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Current controls for one solver — what `GET /api/v1/solvers/:address/anti-griefing`
   * returns. Safe to call for a solver that has never been tracked: it reports
   * a clean, uncapped, unblocked state.
   */
  getStatus(solver: string): AntiGriefingStatus {
    const now = this.now();
    const state = this.states.get(solver);
    if (!state) {
      return this.emptyStatus(solver);
    }
    this.refreshSuspension(state, now);
    const { samples, filled, unfilled, ratio } = this.evaluate(state, now);
    return {
      solver,
      enabled: this.enabled,
      level: state.level,
      samples,
      filled,
      unfilled,
      unfilledRatio: ratio,
      cooldownUntil: state.cooldownUntil !== null && state.cooldownUntil > now ? state.cooldownUntil : null,
      suspended: state.suspended,
      suspendedUntil: state.suspended ? state.suspendedUntil : null,
      concurrencyCap: state.level >= 2 ? this.concurrencyCap : null,
      reputationPenalty: this.reputationPenalty(solver),
      windowSeconds: this.windowMs / 1000,
      minSamples: this.minSamples,
      thresholdRatio: this.thresholdRatio,
    };
  }

  /** Status for every solver that has been observed, sorted by tier then ratio. */
  getAllStatuses(): AntiGriefingStatus[] {
    return [...this.states.keys()]
      .map((solver) => this.getStatus(solver))
      .sort((a, b) => b.level - a.level || b.unfilledRatio - a.unfilledRatio);
  }

  /**
   * Multiplier to apply to a solver's reputation score (issue #453:
   * "reputation impact"). Returns `1` while the solver is unpunished, so
   * existing leaderboards are unchanged by default.
   */
  reputationPenalty(solver: string): number {
    if (!this.enabled) return 1;
    const state = this.states.get(solver);
    if (!state) return 1;
    this.refreshSuspension(state, this.now());
    return REPUTATION_PENALTY_BY_LEVEL[state.level];
  }

  /** Audit trail, newest first. Pass `solver` to scope it to one solver. */
  getAudit(filter: { solver?: string; limit?: number } = {}): AntiGriefingAuditEntry[] {
    const limit = Math.min(filter.limit ?? 100, MAX_AUDIT_ENTRIES);
    const matching = filter.solver
      ? this.audit.filter((entry) => entry.solver === filter.solver)
      : this.audit;
    return matching.slice(-limit).reverse();
  }

  /** Every incident the admins have declared, newest first. */
  listIncidents(): AntiGriefingIncident[] {
    return [...this.incidents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  // ── Incident management (admin) ────────────────────────────────────────────

  /**
   * Open an incident window during which unfilled accepts are not counted
   * (issue #453: "legitimate failures due to chain outages should be
   * excludable by admin incident flag").
   *
   * @param params.chain  Chain to cover, or omit/`null` to cover every chain.
   */
  beginIncident(params: { chain?: string | null; reason: string; actor: string }): AntiGriefingIncident {
    const startedAt = this.now();
    const incident: AntiGriefingIncident = {
      id: `incident-${++this.incidentSeq}`,
      chain: params.chain ? params.chain.toLowerCase() : null,
      reason: params.reason,
      actor: params.actor,
      startedAt,
      endedAt: null,
      excludeUntil: null,
    };
    this.pruneIncidents();
    this.incidents.set(incident.id, incident);
    this.pushAudit({
      solver: null,
      action: "incident_opened",
      level: 0,
      ratio: 0,
      chain: incident.chain ?? undefined,
      reason: params.reason,
      actor: params.actor,
    });
    this.logger.warn(
      `[anti-griefing] incident ${incident.id} opened by ${params.actor} ` +
        `chain=${incident.chain ?? "*"} reason="${params.reason}"`,
    );
    return incident;
  }

  /**
   * Close an incident.
   *
   * @param excludeUntil  Failures up to this epoch-ms instant stay excused
   *   after closure, covering slashing detected by a later sweep. Defaults to
   *   the closure time (only failures *during* the incident are excused).
   * @returns The closed incident, or `null` when the id is unknown.
   */
  endIncident(id: string, options: { excludeUntil?: number; actor?: string } = {}): AntiGriefingIncident | null {
    const incident = this.incidents.get(id);
    if (!incident || incident.endedAt !== null) return null;

    const endedAt = this.now();
    incident.endedAt = endedAt;
    incident.excludeUntil = options.excludeUntil ?? endedAt;
    this.pushAudit({
      solver: null,
      action: "incident_closed",
      level: 0,
      ratio: 0,
      chain: incident.chain ?? undefined,
      reason: `closed incident ${id}`,
      actor: options.actor,
    });
    this.logger.warn(
      `[anti-griefing] incident ${id} closed by ${options.actor ?? "system"} ` +
        `excludeUntil=${incident.excludeUntil}`,
    );
    return incident;
  }

  /**
   * Clear every anti-griefing control on `solver` (operator break-glass).
   *
   * The rolling window is deliberately *kept*: clearing a punishment must not
   * erase the evidence it was based on.
   */
  clear(solver: string, actor: string): AntiGriefingStatus {
    const state = this.getState(solver);
    const before = state.level;
    state.level = 0;
    state.cooldownUntil = null;
    state.suspended = false;
    state.suspendedUntil = null;
    this.pushAudit({
      solver,
      action: "manual_reset",
      level: 0,
      ratio: this.evaluate(state, this.now()).ratio,
      reason: `controls cleared by ${actor} (was level ${before})`,
      actor,
    });
    this.logger.warn(`[anti-griefing] controls cleared for ${solver} by ${actor} (was level ${before})`);
    return this.getStatus(solver);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private canEscalate(state: SolverGriefState, now: number): boolean {
    // One tier per breach: while the cooldown is running the solver has
    // already been punished for this stretch of failures. A level-3 solver
    // whose suspension lapsed is re-suspended by the next breach instead.
    const inCooldown = state.cooldownUntil !== null && state.cooldownUntil > now;
    if (inCooldown) return false;
    if (state.level < 3) return true;
    return !state.suspended;
  }

  private escalate(
    solver: string,
    state: SolverGriefState,
    ratio: number,
    intentId: string,
    chain: string,
  ): void {
    const now = this.now();
    const level = (Math.min(3, state.level + 1) as AntiGriefingLevel);
    state.level = level;

    if (level === 3) {
      state.suspended = true;
      // suspensionMs === 0 → indefinite: only an operator can lift it.
      state.suspendedUntil = this.suspensionMs > 0 ? now + this.suspensionMs : null;
      state.cooldownUntil = null;
    } else {
      state.cooldownUntil = now + this.cooldownMs;
      if (state.suspended && state.suspendedUntil !== null && state.suspendedUntil <= now) {
        state.suspended = false;
        state.suspendedUntil = null;
      }
    }

    const action: AntiGriefingAuditAction =
      level === 1 ? "cooldown" : level === 2 ? "concurrency_cap" : "suspended";
    const reason =
      level === 1
        ? `cooling down for ${Math.round(this.cooldownMs / 1000)}s after unfilled ratio ${ratio.toFixed(2)}`
        : level === 2
          ? `concurrency capped at ${this.concurrencyCap} after unfilled ratio ${ratio.toFixed(2)}`
          : `suspended after unfilled ratio ${ratio.toFixed(2)}`;

    this.pushAudit({
      solver,
      action,
      level,
      ratio,
      intentId,
      chain,
      reason,
    });
    this.metrics?.incAntiGriefingAction(solver, action);
    this.logger.warn(
      `[anti-griefing] escalated ${solver} to level ${level} (${action}) — ` +
        `unfilledRatio=${ratio.toFixed(2)} intent=${intentId} chain=${chain}`,
    );
  }

  private recover(solver: string, state: SolverGriefState, ratio: number): void {
    const from = state.level;
    state.level = (Math.max(0, state.level - 1) as AntiGriefingLevel);
    state.cooldownUntil = null;
    state.suspended = false;
    state.suspendedUntil = null;

    this.pushAudit({
      solver,
      action: "recovered",
      level: state.level,
      ratio,
      reason: `unfilled ratio ${ratio.toFixed(2)} recovered — stepped down from level ${from}`,
    });
    this.metrics?.incAntiGriefingAction(solver, "recovered");
    this.logger.log(
      `[anti-griefing] ${solver} stepped down from level ${from} to ${state.level} ` +
        `(unfilledRatio=${ratio.toFixed(2)})`,
    );
  }

  private auditBlocked(
    solver: string,
    code: AntiGriefingErrorCode,
    state: SolverGriefState,
    intentId: string,
    details: Record<string, unknown>,
  ): void {
    this.pushAudit({
      solver,
      action: "blocked",
      level: state.level,
      ratio: this.evaluate(state, this.now()).ratio,
      intentId,
      reason: `${code}: ${JSON.stringify(details)}`,
    });
  }

  /**
   * Summarise the rolling window. Also prunes outcomes that have aged out, so
   * every read sees a window bounded by `ANTIGRIEFING_WINDOW_SECONDS`.
   */
  private evaluate(
    state: SolverGriefState,
    now: number,
  ): { samples: number; filled: number; unfilled: number; ratio: number } {
    const cutoff = now - this.windowMs;
    const live = state.outcomes.filter((o) => o.at >= cutoff);
    if (live.length !== state.outcomes.length) state.outcomes = live;

    let filled = 0;
    let unfilled = 0;
    for (const outcome of live) {
      if (outcome.outcome === "filled") filled++;
      else unfilled++;
    }
    const samples = filled + unfilled;
    return { samples, filled, unfilled, ratio: samples === 0 ? 0 : unfilled / samples };
  }

  private pruneOutcomes(state: SolverGriefState, now: number): void {
    if (state.outcomes.length <= MAX_OUTCOMES_PER_SOLVER) return;
    const cutoff = now - this.windowMs;
    state.outcomes = state.outcomes.filter((o) => o.at >= cutoff).slice(-MAX_OUTCOMES_PER_SOLVER);
  }

  private refreshSuspension(state: SolverGriefState, now: number): void {
    if (state.suspended && state.suspendedUntil !== null && state.suspendedUntil <= now) {
      state.suspended = false;
      state.suspendedUntil = null;
    }
  }

  private isIncidentCovering(chain: string, at: number): boolean {
    const normalized = chain.toLowerCase();
    for (const incident of this.incidents.values()) {
      if (incident.chain !== null && incident.chain !== normalized) continue;
      if (incident.startedAt > at) continue;
      const until = incident.excludeUntil;
      if (until !== null && at > until) continue;
      if (until === null && incident.endedAt !== null) continue;
      return true;
    }
    return false;
  }

  private getState(solver: string): SolverGriefState {
    let state = this.states.get(solver);
    if (state) return state;
    if (this.states.size >= MAX_TRACKED_SOLVERS) this.pruneStates();
    state = { outcomes: [], level: 0, cooldownUntil: null, suspended: false, suspendedUntil: null };
    this.states.set(solver, state);
    return state;
  }

  /** Drop trackers that carry neither history nor a punishment. */
  private pruneStates(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [solver, state] of this.states) {
      const punished = state.level > 0 || state.suspended;
      const hasHistory = state.outcomes.some((o) => o.at >= cutoff);
      if (!punished && !hasHistory) this.states.delete(solver);
    }
  }

  private pruneIncidents(): void {
    if (this.incidents.size < MAX_INCIDENTS) return;
    const closed = [...this.incidents.values()]
      .filter((incident) => incident.endedAt !== null)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const incident of closed) {
      if (this.incidents.size < MAX_INCIDENTS) break;
      this.incidents.delete(incident.id);
    }
  }

  private pushAudit(entry: Omit<AntiGriefingAuditEntry, "id" | "timestamp">): void {
    this.audit.push({ id: ++this.auditSeq, timestamp: this.now(), ...entry });
    if (this.audit.length > MAX_AUDIT_ENTRIES) {
      this.audit.splice(0, this.audit.length - MAX_AUDIT_ENTRIES);
    }
  }

  private emptyStatus(solver: string): AntiGriefingStatus {
    return {
      solver,
      enabled: this.enabled,
      level: 0,
      samples: 0,
      filled: 0,
      unfilled: 0,
      unfilledRatio: 0,
      cooldownUntil: null,
      suspended: false,
      suspendedUntil: null,
      concurrencyCap: null,
      reputationPenalty: 1,
      windowSeconds: this.windowMs / 1000,
      minSamples: this.minSamples,
      thresholdRatio: this.thresholdRatio,
    };
  }

  private now(): number {
    return Date.now();
  }
}

interface SolverGriefState {
  outcomes: GriefOutcome[];
  level: AntiGriefingLevel;
  /** Epoch ms until which accepts are refused; `null` when not cooling down. */
  cooldownUntil: number | null;
  suspended: boolean;
  /** Epoch ms when a time-boxed suspension lapses; `null` when indefinite. */
  suspendedUntil: number | null;
}
