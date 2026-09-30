import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import configuration, { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";

export type ServiceRole = "api" | "ws" | "worker";

export interface IndicatorResult {
  status: "up" | "down";
  details?: Record<string, unknown>;
  error?: string;
}

/** A dependency check contributed by any module (issue #492). */
export interface HealthIndicator {
  name: string;
  /** Roles for which a "down" result makes the replica not ready. */
  criticalFor: ServiceRole[];
  /** Must have passed once before /health/startup succeeds (migrations, warm caches). */
  startup?: boolean;
  check(): Promise<IndicatorResult>;
}

export interface CachedResult extends IndicatorResult {
  critical: boolean;
  checkedAt: string;
  durationMs: number;
}

/** A check that hangs is reported down after this long. */
const CHECK_TIMEOUT_MS = 3_000;
const LAG_SAMPLE_MS = 100;

/**
 * Health-indicator registry (issue #492).
 *
 * Modules register indicators with per-role criticality. All checks run in
 * the background every HEALTH_CHECK_INTERVAL_MS; the probe endpoints only
 * read the cached results, so they answer in well under 50 ms whatever the
 * dependencies are doing. Readiness uses hysteresis: it turns false only
 * after HEALTH_READY_FAILURE_THRESHOLD consecutive failing evaluations and
 * true again after HEALTH_READY_SUCCESS_THRESHOLD consecutive passing ones.
 */
@Injectable()
export class HealthIndicatorRegistry implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HealthIndicatorRegistry.name);
  private readonly indicators = new Map<string, HealthIndicator>();
  private readonly results = new Map<string, CachedResult>();
  private readonly startupPassed = new Set<string>();
  private readonly cfg: AppConfig["health"];
  /** Event-loop lag sampler: drift of a fixed-interval timer. */
  private readonly lagTimer: NodeJS.Timeout;
  private loopLagMs = 0;
  private timer?: NodeJS.Timeout;
  private evaluated = false;
  private ready = false;
  private failStreak = 0;
  private passStreak = 0;
  private lastLoopLagMs = 0;

  constructor(
    @Optional() config?: ConfigService<AppConfig, true>,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.cfg = config?.get("health", { infer: true }) ?? configuration().health;
    let expected = Date.now() + LAG_SAMPLE_MS;
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.loopLagMs = Math.max(this.loopLagMs, now - expected);
      expected = now + LAG_SAMPLE_MS;
    }, LAG_SAMPLE_MS);
    this.lagTimer.unref?.();
  }

  register(indicator: HealthIndicator): void {
    this.indicators.set(indicator.name, indicator);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.evaluate();
    this.timer = setInterval(() => void this.evaluate(), this.cfg.checkIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    clearInterval(this.lagTimer);
  }

  /** Runs every check once, updates the cache, hysteresis and metrics. */
  async evaluate(): Promise<void> {
    this.lastLoopLagMs = this.loopLagMs;
    this.loopLagMs = 0;

    await Promise.all(
      [...this.indicators.values()].map(async (indicator) => {
        const started = performance.now();
        let result: IndicatorResult;
        try {
          result = await Promise.race([
            indicator.check(),
            new Promise<IndicatorResult>((resolve) =>
              setTimeout(() => resolve({ status: "down", error: `timed out after ${CHECK_TIMEOUT_MS}ms` }), CHECK_TIMEOUT_MS).unref?.(),
            ),
          ]);
        } catch (err) {
          result = { status: "down", error: err instanceof Error ? err.message : String(err) };
        }
        const durationMs = performance.now() - started;
        this.results.set(indicator.name, {
          ...result,
          critical: this.isCritical(indicator),
          checkedAt: new Date().toISOString(),
          durationMs: Math.round(durationMs),
        });
        if (result.status === "up" && indicator.startup) this.startupPassed.add(indicator.name);
        this.metrics?.healthIndicatorUp.set({ indicator: indicator.name }, result.status === "up" ? 1 : 0);
        this.metrics?.healthCheckDuration.observe({ indicator: indicator.name }, durationMs / 1000);
      }),
    );

    const passing = [...this.results.values()].every((r) => !r.critical || r.status === "up");
    if (passing) {
      this.passStreak += 1;
      this.failStreak = 0;
    } else {
      this.failStreak += 1;
      this.passStreak = 0;
    }
    const wasReady = this.ready;
    if (!this.evaluated) this.ready = passing;
    else if (this.ready && this.failStreak >= this.cfg.readyFailureThreshold) this.ready = false;
    else if (!this.ready && this.passStreak >= this.cfg.readySuccessThreshold) this.ready = true;
    this.evaluated = true;
    if (wasReady !== this.ready) this.logger.warn(`readiness changed: ${wasReady} -> ${this.ready}`);
    this.metrics?.healthReady.set(this.ready ? 1 : 0);
  }

  /** Liveness: the event loop is responsive. Dependencies never affect it. */
  liveness() {
    const lag = Math.max(this.lastLoopLagMs, this.loopLagMs);
    return { alive: lag <= this.cfg.eventLoopMaxLagMs, eventLoopLagMs: Math.round(lag) };
  }

  /** Readiness for this process's roles, from cached results. */
  readiness() {
    const indicators = Object.fromEntries(this.results);
    const degraded = [...this.results.values()].some((r) => r.status === "down");
    return {
      ready: this.ready,
      status: !this.ready ? "not_ready" : degraded ? "degraded" : "ok",
      roles: this.cfg.roles,
      indicators,
    };
  }

  /** Startup: every startup indicator (migrations, warmed caches) has passed once. */
  startup() {
    const pending = [...this.indicators.values()]
      .filter((i) => i.startup && !this.startupPassed.has(i.name))
      .map((i) => ({ name: i.name, ...(this.results.get(i.name) ?? { status: "pending" }) }));
    return { started: this.evaluated && pending.length === 0, pending };
  }

  /** Cached result for one indicator (used by the legacy /health payload). */
  result(name: string): CachedResult | undefined {
    return this.results.get(name);
  }

  private isCritical(indicator: HealthIndicator): boolean {
    return indicator.criticalFor.some((role) => this.cfg.roles.includes(role));
  }
}
