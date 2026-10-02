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
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * p) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIt; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * p) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * p) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function regularizedIncompleteBeta(p: number, a: number, b: number): number {
  // B(a,b; p) / B(a,b) via the continued-fraction form (Numerical Recipes §6.4).
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bt =
    Math.exp(
      logGamma(a + b) -
        logGamma(a) -
        logGamma(b) +
        a * Math.log(p) +
        b * Math.log(1 - p),
    );
  // Both branches share the prefactor `bt`, but the second one relies on the
  // symmetry I_x(a,b) = 1 − I_{1−x}(b,a): its continued fraction must be
  // re-evaluated with the parameters swapped and the argument mirrored.
  // Reusing the first branch's value here silently produced garbage for every
  // p ≥ (a+1)/(a+b+2) with asymmetric (a, b) — e.g. I_0.5(1, 2) returned
  // 0.625 instead of 0.75, and the reputation fill-rate quantile came out
  // backwards for well-established performers.
  if (p < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, p)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - p)) / b;
}

function betaQuantile(q: number, a: number, b: number): number {
  // Inverse of regularizedIncompleteBeta(q; a, b) with a simple bracketing
  // + 30 Newton steps. Error is typically < 1e-10, plenty for a ranking score.
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  if (a <= 0 || b <= 0 || !Number.isFinite(a) || !Number.isFinite(b)) {
    return 0;
  }
  // Initial guess via Wilson-score-style normal approximation.
  const z = normInv(q);
  const mean = a / (a + b);
  const varEst = Math.max(1e-12, (a * b) / ((a + b) * (a + b) * (a + b + 1)));
  let x = clamp(mean + z * Math.sqrt(varEst));
  // Bracket the root.
  let lo = 0;
  let hi = 1;
  for (let guard = 0; guard < 30; guard++) {
    const fx = regularizedIncompleteBeta(x, a, b) - q;
    // Beta density at x: x^(a−1) (1−x)^(b−1) / B(a,b). The previous form put
    // the logΓ combination inside the exponent AND divided by B(a,b); those
    // logΓ terms already fold in 1/B(a,b), so the slope was inflated by a
    // factor 1/B, which threw Newton's step across the root and made the
    // inverse quantile wander for well-established (large a,b) performers.
    const df =
      Math.exp(
        (a - 1) * Math.log(Math.max(x, 1e-300)) +
          (b - 1) * Math.log(Math.max(1 - x, 1e-300)),
      ) / betaFunction(a, b);
    if (fx > 0) hi = x;
    else lo = x;
    if (Math.abs(fx) < 1e-12) break;
    const step = df > 0 ? fx / df : (hi - lo) * (fx > 0 ? -0.5 : 0.5);
    x = clamp(x - step);
    if (x >= hi) x = 0.5 * (lo + hi);
    if (x <= lo) x = 0.5 * (lo + hi);
  }
  return x;
}

function normInv(p: number): number {
  // Acklam's inverse normal CDF approximation — good to ~1.15e-9 rel error.
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ReputationService — wraps the pure function with persistence, snapshotting,
// and integration with the SolversService / intents layer.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_SECONDS: Record<string, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

/** Any intent-like record with the fields we need to build reputation inputs. */
interface ReputationIntentLike {
  readonly solver?: string | null;
  readonly state: string;
  readonly createdAt: number;
  readonly filledAt?: number | null;
  readonly slashedAt?: number | null;
  readonly fillAmount?: string | null;
  readonly amountInUsd?: number | null;
  readonly acceptedAt?: number | null;
  readonly deadlineAt?: number | null;
}

@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);
  private readonly snapshots = new Map<string, ReputationDailySnapshot[]>();
  private _lastSnapshotDateKey: string | null = null;

  constructor(
    @Inject(SOLVERS_REPOSITORY)
    private readonly solvers: ISolversRepository,
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() private readonly solversService?: SolversService,
  ) {}

  /** Current runtime config (weights, half-life, etc.) from env vars. */
  getConfig(): ReputationConfig {
    const rep = this.config.get("reputation", { infer: true });
    return {
      weights: {
        fillRate: rep.weights.fillRate,
        latency: rep.weights.latency,
        slashes: rep.weights.slashes,
        quoteHonour: rep.weights.quoteHonour,
        volume: rep.weights.volume,
      },
      decayHalflifeSeconds: rep.decayHalflifeSeconds,
      bayesAlpha: rep.bayesAlpha,
      bayesBeta: rep.bayesBeta,
      volumeLambdaUsd: rep.volumeLambdaUsd,
    };
  }

  /**
   * Compute reputation for `solverAddress` by walking the intents + slash
   * history and calling the pure `computeReputation` function.
   */
  getForSolver(
    solverAddress: string,
    intents: ReputationIntentLike[],
    slashes: SlashRecord[],
    overrideNow?: number,
  ): ReputationScore | null {
    const now = overrideNow ?? Math.floor(Date.now() / 1000);
    const cfg = this.getConfig();
    const inputs = this.buildInputs(solverAddress, intents, slashes, now);
    return computeReputation(inputs, cfg);
  }

  /**
   * Build a {@link ReputationInputs} record for a solver from the raw intent
   * + slash streams. Public so tests and the controller can reuse it.
   */
  buildInputs(
    solverAddress: string,
    intents: ReputationIntentLike[],
    slashes: SlashRecord[],
    evaluatedAtEpoch: number,
  ): ReputationInputs {
    const fills: ReputationFillEvent[] = [];
    const volumes: ReputationVolumeEvent[] = [];
    const quotes: ReputationQuoteEvent[] = [];

    for (const intent of intents) {
      if ((intent.solver ?? null) !== solverAddress) continue;
      if (intent.state === "filled" && intent.filledAt != null) {
        const latency =
          intent.acceptedAt != null
            ? Math.max(0, intent.filledAt - intent.acceptedAt)
            : undefined;
        const fillWindow =
          intent.deadlineAt != null && intent.acceptedAt != null
            ? Math.max(1, intent.deadlineAt - intent.acceptedAt)
            : undefined;
        fills.push({
          timestamp: intent.filledAt,
          success: true,
          fillLatencySec: latency,
          fillWindowSec: fillWindow,
        });
        const usd = Number(intent.amountInUsd ?? 0);
        if (Number.isFinite(usd) && usd > 0) {
          volumes.push({ timestamp: intent.filledAt, amountUsd: usd });
        }
        // A completed fill honours the matching quote.
        quotes.push({ timestamp: intent.filledAt, honoured: true });
      } else if (intent.state === "slashed" && intent.slashedAt != null) {
        fills.push({ timestamp: intent.slashedAt, success: false });
        // A slashed intent also represents a broken quote promise.
        quotes.push({ timestamp: intent.slashedAt, honoured: false });
      }
    }

    const slashEvents: ReputationSlashEvent[] = slashes.map((s) => ({
      timestamp: s.timestamp,
      severity: 1,
      disputeStatus: s.disputeStatus,
    }));

    return {
      fills,
      slashes: slashEvents,
      quotes,
      volumes,
      evaluatedAtEpoch,
    };
  }

  /**
   * Persist one snapshot per solver (sorted by date desc). Writes happen in
   * `takeDailySnapshot`; reads happen in `getHistory`.
   */
  recordSnapshot(solver: SolverRecord, score: ReputationScore, dateKey: string, epoch: number): void {
    const existing = this.snapshots.get(solver.address) ?? [];
    const snap: ReputationDailySnapshot = {
      date: dateKey,
      evaluatedAtEpoch: epoch,
      score: score.score,
      components: {
        fillRate: score.components.fillRate,
        latency: score.components.latency,
        slashes: score.components.slashes,
        quoteHonour: score.components.quoteHonour,
        volume: score.components.volume,
      },
    };
    // Replace an existing entry for the same date, otherwise append and cap.
    const idx = existing.findIndex((e) => e.date === dateKey);
    if (idx >= 0) existing[idx] = snap;
    else existing.unshift(snap);
    existing.sort((a, b) => (a.date < b.date ? 1 : -1));
    const windowDays = this.config.get("reputation.historyWindowDays", { infer: true });
    const trimmed = existing.slice(0, Math.max(1, windowDays));
    this.snapshots.set(solver.address, trimmed);
  }

  /**
   * Trigger a daily snapshot run. Intended to be wired via a Cron job in a
   * follow-up PR; exposed here as a plain method so tests can drive it.
   */
  takeDailySnapshot(
    allIntents: ReputationIntentLike[],
    slashesBySolver: Map<string, SlashRecord[]>,
    overrideNow?: number,
  ): number {
    const now = overrideNow ?? Math.floor(Date.now() / 1000);
    const d = new Date(now * 1000);
    const dateKey =
      d.getUTCFullYear() +
      "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getUTCDate()).padStart(2, "0");
    if (this._lastSnapshotDateKey === dateKey) return 0;
    const all = this.solvers.findAll();
    const solvers = Array.isArray(all) ? all : [];
    let written = 0;
    for (const s of solvers) {
      const slashes = slashesBySolver.get(s.address) ?? [];
      const inputs = this.buildInputs(s.address, allIntents, slashes, now);
      const score = computeReputation(inputs, this.getConfig());
      this.recordSnapshot(s, score, dateKey, now);
      written += 1;
    }
    this._lastSnapshotDateKey = dateKey;
    return written;
  }

  /** Return the trailing N snapshots for a solver (most recent first). */
  getHistory(solverAddress: string, limit?: number): ReputationDailySnapshot[] {
    const list = this.snapshots.get(solverAddress) ?? [];
    const defaultCap = this.config.get("reputation.historyWindowDays", { infer: true });
    const safeCap: number = typeof defaultCap === "number" ? defaultCap : 30;
    const cap: number = typeof limit === "number" ? limit : safeCap;
    return list.slice(0, Math.max(1, cap));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helper used by leaderboard + controller to rank a window of intents
// into reputation events without duplicating the buildInputs logic.
// ─────────────────────────────────────────────────────────────────────────────

export function applyWindowFilter<T extends ReputationIntentLike>(
  intents: T[],
  window: "24h" | "7d" | "30d" | "all",
  now: number,
): T[] {
  if (window === "all") return intents;
  const cutoff = now - (WINDOW_SECONDS[window] ?? 0);
  return intents.filter((i) => {
    const ts =
      i.state === "filled"
        ? i.filledAt ?? i.createdAt
        : i.state === "slashed"
        ? i.slashedAt ?? i.createdAt
        : i.createdAt;
    return ts >= cutoff;
  });
}
