import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord } from "./solvers.types";
import { SolversService, SlashRecord } from "./solvers.service";

// ─────────────────────────────────────────────────────────────────────────────
// Raw event types — the pure function takes these + cfg and returns a score.
// Nothing in this file depends on injected providers or the wall clock.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReputationFillEvent {
  readonly timestamp: number;
  readonly success: boolean;
  readonly fillLatencySec?: number;
  readonly fillWindowSec?: number;
}

export interface ReputationSlashEvent {
  readonly timestamp: number;
  readonly severity: number;
  readonly disputeStatus?: SlashRecord["disputeStatus"];
}

export interface ReputationQuoteEvent {
  readonly timestamp: number;
  readonly honoured: boolean;
}

export interface ReputationVolumeEvent {
  readonly timestamp: number;
  readonly amountUsd: number;
}

export interface ReputationConfig {
  readonly weights: {
    readonly fillRate: number;
    readonly latency: number;
    readonly slashes: number;
    readonly quoteHonour: number;
    readonly volume: number;
  };
  readonly decayHalflifeSeconds: number;
  readonly bayesAlpha: number;
  readonly bayesBeta: number;
  readonly volumeLambdaUsd: number;
}

export interface ReputationComponents {
  readonly fillRate: number;
  readonly latency: number;
  readonly slashes: number;
  readonly quoteHonour: number;
  readonly volume: number;
}

export interface ReputationScore {
  readonly score: number;
  readonly components: ReputationComponents;
  readonly evaluatedAtEpoch: number;
  readonly weights: ReputationConfig["weights"];
  readonly decayHalflifeSeconds: number;
}

export interface ReputationDailySnapshot {
  readonly date: string; // YYYY-MM-DD
  readonly evaluatedAtEpoch: number;
  readonly score: number;
  readonly components: ReputationComponents;
}

export interface ReputationInputs {
  readonly fills: ReputationFillEvent[];
  readonly slashes: ReputationSlashEvent[];
  readonly quotes: ReputationQuoteEvent[];
  readonly volumes: ReputationVolumeEvent[];
  readonly evaluatedAtEpoch: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohort retention types.
// ─────────────────────────────────────────────────────────────────────────────

export interface CohortRetentionOptions {
  /** Recency window (days) within which `lastActiveAt` counts as active. */
  readonly recencyWindowDays?: number;
  /** Age marks (days) at which to measure retention. Defaults to 7/30/90. */
  readonly marks?: readonly number[];
  /** Evaluation time (epoch ms). Defaults to `Date.now()`. */
  readonly nowEpochMs?: number;
}

export interface CohortRetentionPoint {
  readonly ageDays: number;
  /** Fraction of the cohort still active at this mark, or `null` if the
   *  cohort is too young to measure this mark. */
  readonly retention: number | null;
  readonly activeCount: number;
  readonly measurable: boolean;
}

export interface CohortRetentionReport {
  readonly cohortWeek: string; // ISO date (YYYY-MM-DD) of the week start (Monday, UTC)
  readonly cohortSize: number;
  readonly points: CohortRetentionPoint[];
}

export interface CohortRetentionResult {
  readonly generatedAtEpoch: number;
  readonly recencyWindowDays: number;
  readonly marks: number[];
  readonly cohorts: CohortRetentionReport[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure scoring function.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the solver reputation score.
 *
 * This function has no side effects, reads no global state, and depends only
 * on `inputs` and `cfg`. The same two arguments always produce the same
 * result — the evaluation time is passed in as `inputs.evaluatedAtEpoch`
 * rather than read from `Date.now()`. The function is exported at module
 * scope so unit tests and property tests can import it directly.
 *
 * @see docs/rfcs/0003-solver-reputation-v2.md — full formula + rationale.
 */
export function computeReputation(
  inputs: ReputationInputs,
  cfg: ReputationConfig,
): ReputationScore {
  const now = inputs.evaluatedAtEpoch;
  const ln2 = Math.log(2);
  const half = cfg.decayHalflifeSeconds;
  const decay = (ts: number): number => {
    if (ts >= now) return 1;
    return Math.exp((-ln2 * (now - ts)) / half);
  };

  // ── 1. Fill rate (Bayesian Beta 2.5% lower bound) ──────────────────────────
  let weightedSuccesses = 0;
  let weightedFailures = 0;
  for (const f of inputs.fills) {
    const w = decay(f.timestamp);
    if (f.success) weightedSuccesses += w;
    else weightedFailures += w;
  }
  const alpha = cfg.bayesAlpha + weightedSuccesses;
  const beta = cfg.bayesBeta + weightedFailures;
  const cFill = betaQuantile(0.025, alpha, beta);

  // ── 2. Fill latency ────────────────────────────────────────────────────────
  let latencyNum = 0;
  let latencyDen = 0;
  for (const f of inputs.fills) {
    const w = decay(f.timestamp);
    latencyDen += w;
    if (f.success) {
      const window = f.fillWindowSec ?? 300;
      const latency = f.fillLatencySec ?? Math.max(1, window * 0.5);
      const s = Math.max(0, 1 - latency / window);
      latencyNum += w * s;
    }
  }
  const cLatency = latencyDen > 0 ? latencyNum / latencyDen : 0;

  // ── 3. Slashes (exponential penalty) ───────────────────────────────────────
  let slashPenalty = 0;
  for (const s of inputs.slashes) {
    // Only count slashes that have not been reversed on appeal.
    if (s.disputeStatus === "resolved-reversed") continue;
    const w = decay(s.timestamp);
    const sev = Number.isFinite(s.severity) && s.severity > 0 ? s.severity : 1;
    slashPenalty += w * sev;
  }
  const cSlash = Math.exp(-slashPenalty);

  // ── 4. Quote honouring (Laplace-smoothed ratio) ────────────────────────────
  let weightedHonoured = 0;
  let weightedBroken = 0;
  for (const q of inputs.quotes) {
    const w = decay(q.timestamp);
    if (q.honoured) weightedHonoured += w;
    else weightedBroken += w;
  }
  const cQuote = (weightedHonoured + 1) / (weightedHonoured + weightedBroken + 2);

  // ── 5. Volume (rank-aware normalisation) ───────────────────────────────────
  let decayedVolume = 0;
  for (const v of inputs.volumes) {
    const w = decay(v.timestamp);
    const amt = Number.isFinite(v.amountUsd) && v.amountUsd >= 0 ? v.amountUsd : 0;
    decayedVolume += w * amt;
  }
  const lambda = cfg.volumeLambdaUsd > 0 ? cfg.volumeLambdaUsd : 1;
  const cVol = 1 - Math.exp(-Math.log(1 + decayedVolume) / lambda);

  // ── Final weighted score ───────────────────────────────────────────────────
  const w = cfg.weights;
  const score =
    w.fillRate * cFill +
    w.latency * cLatency +
    w.slashes * cSlash +
    w.quoteHonour * cQuote +
    w.volume * cVol;

  const components: ReputationComponents = {
    fillRate: clamp(cFill),
    latency: clamp(cLatency),
    slashes: clamp(cSlash),
    quoteHonour: clamp(cQuote),
    volume: clamp(cVol),
  };

  return {
    score: clamp(score),
    components,
    evaluatedAtEpoch: now,
    weights: {
      fillRate: w.fillRate,
      latency: w.latency,
      slashes: w.slashes,
      quoteHonour: w.quoteHonour,
      volume: w.volume,
    },
    decayHalflifeSeconds: cfg.decayHalflifeSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure cohort-retention computation.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MARKS: readonly number[] = [7, 30, 90];
const DEFAULT_RECENCY_WINDOW_DAYS = 30;

/**
 * Compute weekly cohort retention across solvers.
 *
 * Solvers are bucketed into weekly cohorts keyed by the UTC Monday of the
 * week containing `registeredAt`. For each cohort we report the fraction of
 * members that are still active at each age mark (7/30/90 days by default).
 *
 * A solver counts as active at a given mark when either `isActive` is true
 * or `lastActiveAt` falls within `recencyWindowDays` of the mark. A mark is
 * only measurable once the cohort has aged past it; otherwise the point is
 * reported with `retention: null` and `measurable: false` rather than a
 * misleading `0%`.
 *
 * Chain-sourced solvers are included on the same footing as API-registered
 * ones — the cohort is defined purely by `registeredAt`.
 */
export function computeCohortRetention(
  solvers: readonly SolverRecord[],
  options: CohortRetentionOptions = {},
): CohortRetentionResult {
  const nowEpochMs = options.nowEpochMs ?? Date.now();
  const recencyWindowDays =
    options.recencyWindowDays && options.recencyWindowDays > 0
      ? options.recencyWindowDays
      : DEFAULT_RECENCY_WINDOW_DAYS;
  const marks =
    options.marks && options.marks.length > 0
      ? [...options.marks].filter((m) => Number.isFinite(m) && m >= 0).sort((a, b) => a - b)
      : [...DEFAULT_MARKS];
  const recencyWindowMs = recencyWindowDays * DAY_MS;

  // Bucket solvers by the UTC Monday of their registration week.
  const buckets = new Map<string, { weekStartMs: number; members: SolverRecord[] }>();
  for (const solver of solvers) {
    const registeredMs = toEpochMs(solver.registeredAt);
    if (registeredMs === null) continue;
    const weekStartMs = startOfUtcWeek(registeredMs);
    const key = new Date(weekStartMs).toISOString().slice(0, 10);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { weekStartMs, members: [] };
      buckets.set(key, bucket);
    }
    bucket.members.push(solver);
  }

  const cohorts: CohortRetentionReport[] = [];
  for (const [cohortWeek, bucket] of buckets) {
    const points: CohortRetentionPoint[] = marks.map((ageDays) => {
      const markMs = bucket.weekStartMs + ageDays * DAY_MS;
      // Too young to measure: the mark has not yet been reached.
      if (markMs > nowEpochMs) {
        return { ageDays, retention: null, activeCount: 0, measurable: false };
      }
      let activeCount = 0;
      for (const member of bucket.members) {
        if (isActiveAt(member, markMs, recencyWindowMs)) activeCount += 1;
      }
      const size = bucket.members.length;
      return {
        ageDays,
        retention: size > 0 ? activeCount / size : null,
        activeCount,
        measurable: size > 0,
      };
    });
    cohorts.push({
      cohortWeek,
      cohortSize: bucket.members.length,
      points,
    });
  }

  // Newest cohorts first — matches how operators read retention tables.
  cohorts.sort((a, b) => (a.cohortWeek < b.cohortWeek ? 1 : a.cohortWeek > b.cohortWeek ? -1 : 0));

  return {
    generatedAtEpoch: nowEpochMs,
    recencyWindowDays,
    marks,
    cohorts,
  };
}

function isActiveAt(solver: SolverRecord, markMs: number, recencyWindowMs: number): boolean {
  if (solver.isActive) return true;
  const lastActiveMs = toEpochMs(solver.lastActiveAt);
  if (lastActiveMs === null) return false;
  // Active if last activity is within the recency window of the mark.
  return markMs - lastActiveMs <= recencyWindowMs;
}

function startOfUtcWeek(epochMs: number): number {
  const d = new Date(epochMs);
  const day = d.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers — Beta quantile via a small Newton step on the incomplete beta
// inverse, plus a compact log-gamma for numerical stability.
// ─────────────────────────────────────────────────────────────────────────────

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function logGamma(x: number): number {
  // Lanczos approximation (g=7, n=9) — standard numerical-recipe form.
  // Plenty of precision for the Beta CDF inverse used here.
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = coefficients[0];
  const t = x + 7 + 0.5;
  for (let i = 1; i < coefficients.length; i++) {
    a += coefficients[i] / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaFunction(a: number, b: number): number {
  return Math.exp(logGamma(a) + logGamma(b) - logGamma(a + b));
}

/**
 * Continued fraction for the incomplete beta function (Numerical Recipes
 * §6.4 `betacf`), evaluated at `(a, b, p)`.
 */
function betaContinuedFraction(a: number, b: number, p: number): number {
  const fpmin = 1e-300;
  const maxIt = 200;
  const eps = 3e-12;
  const qab = a + b;
  const qap = a + 1;

/* … truncated 12795 chars — edit only what you need near the top … */
