/**
 * Chaos test scenario definitions.
 *
 * Each scenario follows the DSL:
 *   inject → act → assert → heal → assert recovery
 *
 * Toxiproxy proxies are defined in docker-compose.yml (chaos profile).
 * The runner (scenarios.runner.ts) orchestrates timing and healing.
 *
 * Determinism guarantees:
 * - Each test seeds its own data and tears it down.
 * - Retries are documented per scenario rather than silently swallowed.
 * - Healing always fires in a finally-block so the proxy is never left broken.
 */

export interface ChaosScenario {
  /** Short ID used in CI reports. */
  id: string;
  /** Human description for the report. */
  description: string;
  /** Toxiproxy proxy name(s) to target. */
  proxies: string[];
  /** Toxics to inject (added before act; removed in heal). */
  toxics: ToxicConfig[];
  /** Expected HTTP status codes from the service under fault. */
  expectedStatusUnderFault: number[];
  /** Max milliseconds before recovery is considered complete after healing. */
  maxRecoveryMs: number;
  /** Whether data loss is acceptable (always false for mutation operations). */
  allowDataLoss: boolean;
  /** Documented retry policy for this scenario. */
  retryPolicy: string;
}

export interface ToxicConfig {
  /** toxic_type: latency | bandwidth | slow_close | timeout | slicer | reset_peer */
  type: string;
  /** Stream: upstream | downstream */
  stream: "upstream" | "downstream";
  /** Toxicity: 0.0–1.0 (fraction of connections affected). */
  toxicity: number;
  attributes: Record<string, number | string>;
}

// ── Toxiproxy proxy names (defined in docker-compose chaos profile) ──────────

const PROXY_SOROBAN  = "soroban-rpc";
const PROXY_POSTGRES = "postgres";
const PROXY_REDIS    = "redis";
const PROXY_HORIZON  = "horizon";

// ── Scenario definitions ─────────────────────────────────────────────────────

export const CHAOS_SCENARIOS: ChaosScenario[] = [

  // 1. Soroban RPC timeout
  {
    id: "rpc-timeout",
    description: "Soroban RPC proxy adds 30 s latency — shadow mode should time out gracefully and not block the HTTP response",
    proxies: [PROXY_SOROBAN],
    toxics: [{ type: "latency", stream: "upstream", toxicity: 1.0, attributes: { latency: 30_000, jitter: 0 } }],
    expectedStatusUnderFault: [200, 201],   // HTTP path must still succeed; shadow is async
    maxRecoveryMs: 5_000,
    allowDataLoss: false,
    retryPolicy: "no retries; shadow mode drops timed-out observations and increments divergence counter",
  },

  // 2. Soroban RPC returns stale ledger sequence
  {
    id: "rpc-stale-ledger",
    description: "Soroban RPC proxy injects 500 ms latency simulating stale response — health check should flag RPC as degraded",
    proxies: [PROXY_SOROBAN],
    toxics: [{ type: "latency", stream: "upstream", toxicity: 1.0, attributes: { latency: 500, jitter: 100 } }],
    expectedStatusUnderFault: [200],
    maxRecoveryMs: 10_000,
    allowDataLoss: false,
    retryPolicy: "RPC health check retries with 1 s back-off; majority quorum required",
  },

  // 3. Soroban RPC total outage
  {
    id: "rpc-outage",
    description: "Soroban RPC proxy drops all connections — on-chain writes should fail closed; off-chain path continues",
    proxies: [PROXY_SOROBAN],
    toxics: [{ type: "timeout", stream: "upstream", toxicity: 1.0, attributes: { timeout: 0 } }],
    expectedStatusUnderFault: [200, 201],   // off-chain intents still created
    maxRecoveryMs: 15_000,
    allowDataLoss: false,
    retryPolicy: "outbox retries: 3 attempts, exponential back-off 1 s / 2 s / 4 s",
  },

  // 4. Postgres primary failover simulation (slow connection)
  {
    id: "postgres-slow",
    description: "Postgres proxy adds 200 ms latency — statement_timeout should fire and service returns 503",
    proxies: [PROXY_POSTGRES],
    toxics: [{ type: "latency", stream: "upstream", toxicity: 1.0, attributes: { latency: 200, jitter: 50 } }],
    expectedStatusUnderFault: [200, 201, 503],
    maxRecoveryMs: 8_000,
    allowDataLoss: false,
    retryPolicy: "no DB retries on write path; reads retry once with statement_timeout",
  },

  // 5. Postgres complete outage
  {
    id: "postgres-outage",
    description: "Postgres proxy drops all connections — service should return 503 for intent mutations; health probe turns unhealthy",
    proxies: [PROXY_POSTGRES],
    toxics: [{ type: "reset_peer", stream: "upstream", toxicity: 1.0, attributes: {} }],
    expectedStatusUnderFault: [503],
    maxRecoveryMs: 20_000,
    allowDataLoss: false,
    retryPolicy: "Prisma reconnects automatically after proxy is healed; health probe clears after 2 consecutive successes",
  },

  // 6. Redis complete outage
  {
    id: "redis-outage",
    description: "Redis proxy drops all connections — WS backplane falls back to in-process; abuse scorer fails open; BullMQ drains on reconnect",
    proxies: [PROXY_REDIS],
    toxics: [{ type: "reset_peer", stream: "upstream", toxicity: 1.0, attributes: {} }],
    expectedStatusUnderFault: [200, 201],   // Redis is not on the synchronous write path
    maxRecoveryMs: 10_000,
    allowDataLoss: false,
    retryPolicy: "ioredis reconnects with default back-off (max 2 s); BullMQ stalled-job requeue on reconnect",
  },

  // 7. Redis bandwidth throttle (simulate Memorystore saturation)
  {
    id: "redis-bandwidth",
    description: "Redis proxy limits bandwidth to 10 KB/s — WS fan-out should degrade gracefully (drop oldest) without dropping connections",
    proxies: [PROXY_REDIS],
    toxics: [{ type: "bandwidth", stream: "upstream", toxicity: 1.0, attributes: { rate: 10 } }],
    expectedStatusUnderFault: [200, 201],
    maxRecoveryMs: 5_000,
    allowDataLoss: false,
    retryPolicy: "WS backplane publish queue drains on bandwidth recovery",
  },

  // 8. Slow Horizon API
  {
    id: "horizon-slow",
    description: "Horizon proxy adds 5 s latency — abuse detector account-age check should time out and skip the new_address rule rather than blocking",
    proxies: [PROXY_HORIZON],
    toxics: [{ type: "latency", stream: "upstream", toxicity: 1.0, attributes: { latency: 5_000, jitter: 0 } }],
    expectedStatusUnderFault: [200, 201],
    maxRecoveryMs: 5_000,
    allowDataLoss: false,
    retryPolicy: "Horizon call is fire-and-forget for abuse scoring; accountAgeSeconds left undefined on timeout",
  },

  // 9. Partial network partition (50 % packet loss)
  {
    id: "partial-partition",
    description: "Postgres proxy drops 50% of packets — partial connectivity should not cause data corruption; intents may fail but not silently half-write",
    proxies: [PROXY_POSTGRES],
    toxics: [{ type: "reset_peer", stream: "upstream", toxicity: 0.5, attributes: {} }],
    expectedStatusUnderFault: [200, 201, 503],
    maxRecoveryMs: 15_000,
    allowDataLoss: false,
    retryPolicy: "Prisma transaction rolls back on error; idempotency key prevents duplicate on client retry",
  },

  // 10. TCP connection reset (abrupt disconnect mid-request)
  {
    id: "soroban-reset",
    description: "Soroban proxy sends TCP RST after connection established — outbox retry mechanism must eventually succeed after healing",
    proxies: [PROXY_SOROBAN],
    toxics: [{ type: "reset_peer", stream: "upstream", toxicity: 1.0, attributes: {} }],
    expectedStatusUnderFault: [200, 201],   // on-chain submission is async via outbox
    maxRecoveryMs: 30_000,
    allowDataLoss: false,
    retryPolicy: "outbox retries: 3 attempts, exponential back-off; alert if DLQ grows",
  },

  // 11. Slow close (half-open connections)
  {
    id: "soroban-slow-close",
    description: "Soroban proxy delays FIN by 10 s — connection pool should not exhaust; keep-alive and timeout settings validated",
    proxies: [PROXY_SOROBAN],
    toxics: [{ type: "slow_close", stream: "upstream", toxicity: 1.0, attributes: { delay: 10_000 } }],
    expectedStatusUnderFault: [200, 201],
    maxRecoveryMs: 20_000,
    allowDataLoss: false,
    retryPolicy: "undici keep-alive timeout evicts half-open connections; no retry needed",
  },

  // 12. Redis + Postgres simultaneous degradation (compound failure)
  {
    id: "compound-degradation",
    description: "Both Redis and Postgres have 100 ms latency simultaneously — service must not deadlock or cascade",
    proxies: [PROXY_REDIS, PROXY_POSTGRES],
    toxics: [
      { type: "latency", stream: "upstream", toxicity: 1.0, attributes: { latency: 100, jitter: 20 } },
    ],
    expectedStatusUnderFault: [200, 201, 503],
    maxRecoveryMs: 20_000,
    allowDataLoss: false,
    retryPolicy: "independent back-off for each dependency; circuit breakers evaluated separately",
  },
];
