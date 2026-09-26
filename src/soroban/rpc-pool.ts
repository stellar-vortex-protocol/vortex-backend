/**
 * Multi-endpoint Soroban RPC pool with health scoring and automatic failover.
 *
 * Architecture
 * ────────────
 * Each endpoint has a circuit breaker (closed/open/half-open) and a rolling
 * health score derived from:
 *   - Rolling error rate (last N requests)
 *   - p95 latency over the same window
 *   - Ledger lag vs. the median of all peers
 *
 * Selection uses weighted-random among healthy endpoints (score ≥ threshold).
 * Writes (sendTransaction) pin to a single endpoint per logical transaction so
 * status lookups and retries hit the same node.
 *
 * Backward compatibility: SOROBAN_RPC_URL still works as a single-URL
 * fallback; SOROBAN_RPC_URLS (comma-separated) extends/replaces it.
 *
 * @module soroban/rpc-pool
 */

import { Logger } from "@nestjs/common";
import { SorobanRpc, Networks, Transaction } from "@stellar/stellar-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface EndpointConfig {
  url: string;
  /** Relative weight for weighted-random selection (default 1). */
  weight: number;
}

export interface EndpointHealth {
  url: string;
  state: CircuitState;
  /** Composite health score in [0, 1]; 1 = perfectly healthy. */
  score: number;
  /** Rolling error rate in [0, 1]. */
  errorRate: number;
  /** p95 latency in ms over the recent window. */
  p95LatencyMs: number;
  /** Ledger lag vs. the current median across all endpoints. */
  ledgerLag: number;
  /** Timestamp of the last successful request. */
  lastSuccessAt: Date | null;
  /** Timestamp of the last error. */
  lastErrorAt: Date | null;
  /** How many consecutive errors triggered the current state. */
  consecutiveErrors: number;
}

export interface RpcPoolOptions {
  endpoints: EndpointConfig[];
  /**
   * Expected network passphrase (e.g. Networks.TESTNET).
   * Endpoints returning a different passphrase are rejected at startup.
   */
  expectedNetwork: string;
  /** Rolling window size for error-rate and latency tracking. Defaults to 20. */
  windowSize?: number;
  /** Error rate above which an endpoint is considered unhealthy. Defaults to 0.5. */
  errorRateThreshold?: number;
  /** Consecutive error count to trip the circuit breaker. Defaults to 3. */
  tripThreshold?: number;
  /** Milliseconds before a tripped endpoint is probed again. Defaults to 30_000. */
  recoveryDelayMs?: number;
  /** Health probe interval in ms. Defaults to 15_000. */
  probeIntervalMs?: number;
  /** Logger instance. */
  logger?: Logger;
}

// ─── Internal endpoint state ──────────────────────────────────────────────────

const WINDOW_SIZE = 20;
const ERROR_RATE_THRESHOLD = 0.5;
const TRIP_THRESHOLD = 3;
const RECOVERY_DELAY_MS = 30_000;

class EndpointState {
  readonly server: SorobanRpc.Server;
  readonly url: string;
  readonly weight: number;

  circuitState: CircuitState = "closed";
  consecutiveErrors = 0;
  lastErrorAt: Date | null = null;
  lastSuccessAt: Date | null = null;
  lastTrippedAt: Date | null = null;

  /** Rolling window of request outcomes: true = success, false = error. */
  private readonly window: boolean[] = [];
  /** Rolling window of latency measurements in ms. */
  private readonly latencies: number[] = [];
  /** Most recently observed ledger sequence. */
  latestLedger = 0;

  constructor(config: EndpointConfig) {
    this.url = config.url;
    this.weight = config.weight;
    this.server = new SorobanRpc.Server(config.url, {
      allowHttp: config.url.startsWith("http://"),
    });
  }

  recordSuccess(latencyMs: number): void {
    this.consecutiveErrors = 0;
    this.lastSuccessAt = new Date();
    this.push(true, latencyMs);
  }

  recordError(latencyMs: number): void {
    this.consecutiveErrors++;
    this.lastErrorAt = new Date();
    this.push(false, latencyMs);
  }

  get errorRate(): number {
    if (this.window.length === 0) return 0;
    const errors = this.window.filter((v) => !v).length;
    return errors / this.window.length;
  }

  get p95LatencyMs(): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)];
  }

  get score(): number {
    // Weighted composite: 50% error rate, 30% latency, 20% ledger-freshness
    // Latency is normalised: 0 ms → 1.0, ≥2000 ms → 0.0
    const errScore = 1 - this.errorRate;
    const latScore = Math.max(0, 1 - this.p95LatencyMs / 2_000);
    return errScore * 0.5 + latScore * 0.3 + 0.2; // ledger component applied outside
  }

  get isHealthy(): boolean {
    return this.circuitState === "closed" && this.errorRate < ERROR_RATE_THRESHOLD;
  }

  private push(success: boolean, latencyMs: number): void {
    this.window.push(success);
    this.latencies.push(latencyMs);
    if (this.window.length > WINDOW_SIZE) this.window.shift();
    if (this.latencies.length > WINDOW_SIZE) this.latencies.shift();
  }
}

// ─── RpcPool ─────────────────────────────────────────────────────────────────

/**
 * Multi-endpoint Soroban RPC pool.
 *
 * Usage:
 *   const pool = await RpcPool.create({ endpoints, expectedNetwork });
 *   const ledger = await pool.getLatestLedger();
 */
export class RpcPool {
  private readonly logger: Logger;
  private readonly endpoints: EndpointState[];
  private readonly tripThreshold: number;
  private readonly recoveryDelayMs: number;
  private readonly errorRateThreshold: number;
  private probeTimer?: NodeJS.Timeout;

  private constructor(
    endpoints: EndpointState[],
    opts: Required<RpcPoolOptions>,
  ) {
    this.logger = opts.logger ?? new Logger(RpcPool.name);
    this.endpoints = endpoints;
    this.tripThreshold = opts.tripThreshold;
    this.recoveryDelayMs = opts.recoveryDelayMs;
    this.errorRateThreshold = opts.errorRateThreshold;
  }

  /**
   * Factory: creates the pool and validates every endpoint against the
   * expected network passphrase. Rejects any endpoint on the wrong network.
   */
  static async create(opts: RpcPoolOptions): Promise<RpcPool> {
    const resolved: Required<RpcPoolOptions> = {
      windowSize: opts.windowSize ?? WINDOW_SIZE,
      errorRateThreshold: opts.errorRateThreshold ?? ERROR_RATE_THRESHOLD,
      tripThreshold: opts.tripThreshold ?? TRIP_THRESHOLD,
      recoveryDelayMs: opts.recoveryDelayMs ?? RECOVERY_DELAY_MS,
      probeIntervalMs: opts.probeIntervalMs ?? 15_000,
      logger: opts.logger ?? new Logger(RpcPool.name),
      ...opts,
    };

    const states = opts.endpoints.map((e) => new EndpointState(e));

    // Validate network passphrase on all endpoints in parallel
    await Promise.all(
      states.map(async (ep) => {
        try {
          const network = await ep.server.getNetwork();
          if (network.passphrase !== opts.expectedNetwork) {
            throw new Error(
              `Endpoint ${ep.url} is on network "${network.passphrase}" but expected "${opts.expectedNetwork}" — rejecting`,
            );
          }
        } catch (err) {
          resolved.logger.warn(
            `[rpc-pool] endpoint validation failed for ${ep.url}: ` +
            `${err instanceof Error ? err.message : String(err)} — marking unhealthy`,
          );
          ep.circuitState = "open";
          ep.lastTrippedAt = new Date();
        }
      }),
    );

    const pool = new RpcPool(states, resolved);
    pool.startProbeLoop(resolved.probeIntervalMs);
    return pool;
  }

  /** Stop background probing (call on module destroy). */
  destroy(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  /**
   * Select a healthy endpoint using weighted-random selection.
   * Throws if no healthy endpoint is available.
   */
  private selectEndpoint(): EndpointState {
    this.maybeRecoverEndpoints();
    const healthy = this.endpoints.filter((e) => e.isHealthy);
    if (healthy.length === 0) {
      // Fallback: use the endpoint with the lowest error rate even if tripped
      const best = [...this.endpoints].sort((a, b) => a.errorRate - b.errorRate)[0];
      this.logger.warn("[rpc-pool] all endpoints unhealthy — using best available");
      return best;
    }

    const totalWeight = healthy.reduce((sum, e) => sum + e.weight * e.score, 0);
    let rand = Math.random() * totalWeight;
    for (const ep of healthy) {
      rand -= ep.weight * ep.score;
      if (rand <= 0) return ep;
    }
    return healthy[healthy.length - 1];
  }

  /**
   * Pin a write operation to a specific endpoint so the caller can issue
   * status lookups to the same node.
   *
   * Returns the endpoint URL so callers can build a pinned pool for retries.
   */
  selectPinnedEndpoint(): { endpoint: EndpointState; url: string } {
    const ep = this.selectEndpoint();
    return { endpoint: ep, url: ep.url };
  }

  // ── Delegating methods (mirroring SorobanRpc.Server interface) ────────────

  async getLatestLedger(): Promise<SorobanRpc.Api.GetLatestLedgerResponse> {
    return this.call((ep) => ep.server.getLatestLedger(), "getLatestLedger");
  }

  async getHealth(): Promise<SorobanRpc.Api.GetHealthResponse> {
    return this.call((ep) => ep.server.getHealth(), "getHealth");
  }

  async getNetwork(): Promise<SorobanRpc.Api.GetNetworkResponse> {
    return this.call((ep) => ep.server.getNetwork(), "getNetwork");
  }

  async getAccount(publicKey: string): Promise<ReturnType<SorobanRpc.Server["getAccount"]>> {
    return this.call((ep) => ep.server.getAccount(publicKey), "getAccount");
  }

  async getEvents(
    request: SorobanRpc.Server.GetEventsRequest,
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return this.call((ep) => ep.server.getEvents(request), "getEvents");
  }

  async getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse> {
    return this.call((ep) => ep.server.getFeeStats(), "getFeeStats");
  }

  async simulateTransaction(
    transaction: Parameters<SorobanRpc.Server["simulateTransaction"]>[0],
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.call(
      (ep) => ep.server.simulateTransaction(transaction),
      "simulateTransaction",
    );
  }

  async prepareTransaction(
    transaction: Parameters<SorobanRpc.Server["prepareTransaction"]>[0],
  ): Promise<Transaction> {
    return this.call(
      (ep) => ep.server.prepareTransaction(transaction) as Promise<Transaction>,
      "prepareTransaction",
    );
  }

  /**
   * Send a transaction, pinned to a single endpoint for consistent status
   * lookups. Returns the endpoint URL alongside the response so callers can
   * target subsequent `getTransaction` calls to the same node.
   */
  async sendTransaction(
    transaction: Parameters<SorobanRpc.Server["sendTransaction"]>[0],
  ): Promise<{ response: SorobanRpc.Api.SendTransactionResponse; pinnedUrl: string }> {
    const { endpoint } = this.selectPinnedEndpoint();
    const start = Date.now();
    try {
      const response = await endpoint.server.sendTransaction(transaction);
      endpoint.recordSuccess(Date.now() - start);
      return { response, pinnedUrl: endpoint.url };
    } catch (err) {
      endpoint.recordError(Date.now() - start);
      this.maybeTrip(endpoint);
      throw err;
    }
  }

  // ── Per-endpoint health report ────────────────────────────────────────────

  /**
   * Returns the health status of every endpoint.
   * Consumed by `/api/v1/chain/health`.
   */
  getEndpointHealth(): EndpointHealth[] {
    const ledgers = this.endpoints.map((e) => e.latestLedger).filter((l) => l > 0);
    const medianLedger =
      ledgers.length > 0
        ? ledgers.sort((a, b) => a - b)[Math.floor(ledgers.length / 2)]
        : 0;

    return this.endpoints.map((ep) => ({
      url: ep.url,
      state: ep.circuitState,
      score: Math.max(0, Math.min(1, ep.score - (medianLedger > 0 ? Math.max(0, (medianLedger - ep.latestLedger) / 1000) * 0.2 : 0))),
      errorRate: ep.errorRate,
      p95LatencyMs: ep.p95LatencyMs,
      ledgerLag: medianLedger > 0 ? Math.max(0, medianLedger - ep.latestLedger) : 0,
      lastSuccessAt: ep.lastSuccessAt,
      lastErrorAt: ep.lastErrorAt,
      consecutiveErrors: ep.consecutiveErrors,
    }));
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async call<T>(
    fn: (ep: EndpointState) => Promise<T>,
    opName: string,
  ): Promise<T> {
    const ep = this.selectEndpoint();
    const start = Date.now();
    try {
      const result = await fn(ep);
      const latencyMs = Date.now() - start;
      ep.recordSuccess(latencyMs);
      // Track latest ledger for lag calculation
      if (opName === "getLatestLedger") {
        ep.latestLedger = (result as SorobanRpc.Api.GetLatestLedgerResponse).sequence;
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      ep.recordError(latencyMs);
      this.maybeTrip(ep);

      this.logger.warn(
        `[rpc-pool] ${opName} failed on ${ep.url} (errorRate=${ep.errorRate.toFixed(2)}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );

      // Try one other endpoint before giving up
      const fallback = this.endpoints
        .filter((e) => e !== ep && e.isHealthy)
        .sort((a, b) => a.errorRate - b.errorRate)[0];

      if (fallback) {
        const start2 = Date.now();
        try {
          const result = await fn(fallback);
          fallback.recordSuccess(Date.now() - start2);
          return result;
        } catch (err2) {
          fallback.recordError(Date.now() - start2);
          this.maybeTrip(fallback);
          throw err2;
        }
      }
      throw err;
    }
  }

  private maybeTrip(ep: EndpointState): void {
    if (
      ep.circuitState === "closed" &&
      ep.consecutiveErrors >= this.tripThreshold
    ) {
      ep.circuitState = "open";
      ep.lastTrippedAt = new Date();
      this.logger.warn(
        `[rpc-pool] circuit breaker TRIPPED for ${ep.url} ` +
        `(consecutiveErrors=${ep.consecutiveErrors})`,
      );
    }
  }

  private maybeRecoverEndpoints(): void {
    const now = Date.now();
    for (const ep of this.endpoints) {
      if (
        ep.circuitState === "open" &&
        ep.lastTrippedAt !== null &&
        now - ep.lastTrippedAt.getTime() >= this.recoveryDelayMs
      ) {
        ep.circuitState = "half-open";
        this.logger.log(
          `[rpc-pool] circuit half-opened for ${ep.url} — probing`,
        );
      }
    }
  }

  private startProbeLoop(intervalMs: number): void {
    this.probeTimer = setInterval(() => {
      this.probeUnhealthy().catch(() => {/* probe errors are silent */});
    }, intervalMs);
    // Don't block process exit
    this.probeTimer.unref?.();
  }

  private async probeUnhealthy(): Promise<void> {
    const candidates = this.endpoints.filter(
      (e) => e.circuitState === "open" || e.circuitState === "half-open",
    );
    for (const ep of candidates) {
      const start = Date.now();
      try {
        await ep.server.getHealth();
        ep.recordSuccess(Date.now() - start);
        ep.circuitState = "closed";
        ep.consecutiveErrors = 0;
        this.logger.log(`[rpc-pool] probe succeeded — ${ep.url} is back to closed`);
      } catch {
        ep.recordError(Date.now() - start);
        ep.circuitState = "open";
        ep.lastTrippedAt = new Date();
      }
    }
  }
}

// ─── Parser helper ────────────────────────────────────────────────────────────

/**
 * Parse a comma-separated list of RPC endpoint URLs with optional weight
 * suffixes (`https://example.com@2` means weight=2).
 *
 * Falls back to a single SOROBAN_RPC_URL entry for backward compatibility.
 *
 * @example
 *   parseRpcUrls("https://a.com,https://b.com@2")
 *   // → [{ url: "https://a.com", weight: 1 }, { url: "https://b.com", weight: 2 }]
 */
export function parseRpcUrls(
  sorobanRpcUrls: string | undefined,
  sorobanRpcUrl: string | undefined,
): EndpointConfig[] {
  const raw = sorobanRpcUrls ?? sorobanRpcUrl ?? "";
  if (!raw.trim()) return [];

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const atIdx = entry.lastIndexOf("@");
      if (atIdx > 8) {
        // "@" after the scheme — treat as weight suffix
        const url = entry.slice(0, atIdx);
        const weight = parseFloat(entry.slice(atIdx + 1));
        return { url, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 };
      }
      return { url: entry, weight: 1 };
    });
}
