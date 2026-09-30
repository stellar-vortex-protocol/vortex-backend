export type FeePercentile =
  | "min"
  | "mode"
  | "p10"
  | "p20"
  | "p30"
  | "p40"
  | "p50"
  | "p60"
  | "p70"
  | "p80"
  | "p90"
  | "p95"
  | "p99"
  | "max";

/**
 * Default open-intent deadline in seconds per source chain.
 *
 * Controls how long after creation an intent can be accepted by a solver.
 * Values are intentionally generous — chains with slower finality get more
 * time so solvers can confidently assess liquidity before committing.
 */
export const CHAIN_DEADLINE_DEFAULTS: Record<string, number> = {
  stellar: 900,    // ~15 min — fast finality
  base: 1800,      // ~30 min
  optimism: 1800,
  arbitrum: 1800,
  ethereum: 3600,  // ~1 hr — slower finality
  polygon: 2700,   // ~45 min
  avalanche: 1800,
};

/** Fallback open-intent deadline when chain is not in the map. */
export const DEFAULT_DEADLINE_SECONDS = 1800;

/**
 * Per-chain fill-window in seconds: the time a solver has from accept to fill.
 *
 * Design rationale
 * ────────────────
 * The fill window is intentionally shorter than the full open-intent deadline
 * (CHAIN_DEADLINE_DEFAULTS) because accept-to-fill should always be a strict
 * subset of the total time budget.  Values are chosen to give solvers
 * realistic execution time on each chain while keeping the slashing window
 * fair:
 *
 *   stellar   120 s  — 5-second ledger time; a solver has plenty of margin.
 *   base      600 s  — 2-second blocks; ~5-min window comfortable for bridging.
 *   optimism  600 s  — same as Base (same block cadence).
 *   arbitrum  600 s  — sub-second blocks but finality waits for L1 batch.
 *   ethereum  1800 s — 12-second slots + confirmation depth = larger window.
 *   polygon   900 s  — ~2-second blocks; moderate finality.
 *   avalanche 600 s  — 1-2 second finality; similar profile to Base/Optimism.
 *
 * These defaults can be overridden at deploy-time via the corresponding
 * FILL_WINDOW_<CHAIN> environment variables (e.g. FILL_WINDOW_ETHEREUM=3600),
 * following the same override mechanism as CHAIN_DEADLINE_DEFAULTS.
 * They are intentionally not exposed as AppConfig fields — like
 * CHAIN_DEADLINE_DEFAULTS they are module-level constants that callers import
 * directly, keeping configuration.ts the single source of truth without
 * forcing every consumer to inject ConfigService for a plain number lookup.
 */
export const CHAIN_FILL_WINDOW_DEFAULTS: Record<string, number> = {
  stellar: 120,    // 2 min — fast finality; solver has ample time
  base: 600,       // 10 min
  optimism: 600,   // 10 min
  arbitrum: 600,   // 10 min — L1 batch delay makes this realistic
  ethereum: 1800,  // 30 min — slower slot + confirmation depth
  polygon: 900,    // 15 min
  avalanche: 600,  // 10 min — fast finality, bridge latency dominates
};

/** Fallback fill-window when chain is not in the map. */
export const DEFAULT_FILL_WINDOW_SECONDS = 600;

/**
 * Stellar network passphrases keyed by the `STELLAR_NETWORK` values the schema
 * accepts.
 *
 * A transaction envelope is only valid for the network it was built for, so
 * anything that assembles an envelope — today only the shadow-mode
 * simulation path in `StellarTxService.simulateContract` — needs this map.
 * It lives next to the other network-derived constants rather than in the
 * service so there is exactly one place to look when a network is added.
 *
 * Lookups fall back to testnet (see `StellarTxService`'s constructor): the
 * worst outcome for a *simulated* envelope is a simulation against the wrong
 * network, which surfaces immediately as a divergence rather than as a silent
 * wrong-network write, because simulation never broadcasts.
 */
export const NETWORK_PASSPHRASES: Record<AppConfig["stellar"]["network"], string> = {
  testnet: "Test SDF Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  mainnet: "Public Global Stellar Network ; September 2015",
};

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  datasets: import("../datasets/datasets.types").DatasetsConfig;
  stellar: {
    network: "testnet" | "futurenet" | "mainnet";
    sorobanRpcUrl: string;
    horizonUrl: string;
    settlementContractId: string;
    solverRegistryContractId: string;
    signerSecretKey: string;
    // Secret key for the backend's Soroban signer. Empty outside production
    // (no on-chain write path exists yet); envValidationSchema requires and
    // format-checks it in production so it can never silently fall back to
    // a placeholder. Never log this value.
    signingKey: string;
    /** Fee percentile to use when estimating Soroban inclusion fees. */
    feePercentile: FeePercentile;
    /** Maximum fee in stroops for fee-bump escalation (#388). */
    maxFeeStroops: number;
    /** Number of channel accounts in the pool (#387). */
    channelPoolSize: number;
    /** Comma-separated list of channel account secret keys (#387). */
    channelSecretKeys: string;
  };
  treasury: {
    address: string;
  };
  onchainIntentsEnabled: boolean;
  legacyStellarSignatures: boolean;
  evm: {
    rpcAllowlist: string[];
    chains: Record<
      "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche",
      { chainId: number; rpcUrl: string; escrowAddress: string }
    >;
  };
  intentRetentionDays: number;
  intentRetentionSweepMs: number;
  /**
   * Dry-run flag for on-chain write paths (issue #260).
   *
   * When true every write path (invokeContract, slashSolver) simulates and
   * logs but never broadcasts a transaction.  Defaults to true outside
   * production; must be explicitly set in production (validated by
   * envValidationSchema — see src/config/env.validation.ts).
   *
   * This value is the env default. At runtime the `onchain-dry-run` feature
   * flag (src/flags/, issue #495) can override it without a restart — see
   * docs/runbooks/onchain-cutover.md for the staged rollout procedure.
   */
  onchainDryRun: boolean;
  corsOrigin: string;
  /** Maximum concurrent WebSocket connections (0 = unlimited). */
  wsMaxConnections: number;
  wsBackplane: "memory" | "redis";
  redisUrl: string;

  // ── Resource-exhaustion limits (issue #476) ───────────────────────────────
  /** Maximum JSON nesting depth accepted by the body parser middleware. */
  jsonMaxDepth: number;
  /** Maximum chain-filter values in a single WS subscribe message. */
  wsMaxFilterChains: number;
  /** Maximum concurrent active subscriptions per WS connection. */
  wsMaxSubscriptions: number;
  /** Default Postgres statement_timeout (ms) for standard route queries. */
  dbQueryTimeoutMs: number;
  /** Postgres statement_timeout (ms) for batch-lookup queries. */
  dbBatchQueryTimeoutMs: number;
  /** Postgres statement_timeout (ms) for stats/aggregate queries. */
  dbStatsQueryTimeoutMs: number;

  // ── Emergency kill-switch (issue #477) ─────────────────────────────────────
  killswitch: {
    /**
     * Shared secret for the operator control plane (`/api/v1/ops/killswitch`).
     * Empty disables those routes entirely — the control plane is never open.
     */
    operatorToken: string;
    /**
     * Redis URL used for cross-replica pause propagation. Empty falls back to
     * database polling only, which still meets the propagation budget.
     */
    redisUrl: string;
    /**
     * Interval (ms) for the `max_updated_at` probe that backstops Redis pub/sub.
     * Worst-case propagation delay is roughly this value, so it must stay
     * comfortably under the 5 s propagation requirement.
     */
    pollMs: number;
  };

  /**
   * Shadow-mode divergence monitor (issue #401).
   *
   * Runs read-only on-chain simulations of every intent state transition in
   * parallel with the authoritative off-chain path and reports where the two
   * disagree. See docs/runbooks/onchain-cutover.md for the go/no-go threshold.
   */
  shadow: {
    /** Master switch. When false, `ShadowService.observe` is a no-op. */
    enabled: boolean;
    /** Fraction of transitions to simulate, in `[0, 1]`. `1` = every one. */
    sampleRate: number;
    /** Hard cap on queued observations; beyond this they are dropped + counted. */
    queueMax: number;
    /** How many observations the background drain simulates concurrently. */
    concurrency: number;
    /**
     * Public key used as the source account for simulation envelopes.
     *
     * Never signed, never submitted, never charged — it only has to be a valid
     * StrKey. Empty means "simulate nothing", which the monitor reports as
     * `contract_unconfigured` rather than as zero divergence.
     */
    sourceAccount: string;
  };

  governance: {
    /**
     * On-chain governance / parameters contract ID.
     * When set, ProtocolParamsService reads current + scheduled parameters
     * from this contract and exposes them via GET /api/v1/params.
     * Leave blank to use code / env defaults only.
     */
    paramsContractId: string;
    /**
     * How often (in milliseconds) to poll the parameters contract for changes.
     * Default: 30 000 ms (30 s).
     */
    paramsPollIntervalMs: number;
  };

  leaderElection: {
    /** When false, all workers run unconditionally (pre-election behaviour). */
    enabled: boolean;
    /** Heartbeat interval in ms (default 5000). */
    heartbeatMs: number;
  };
  /**
   * Process role (issue #494). Producers may enqueue jobs from any role;
   * queue workers only run when the role is "worker" or "all".
   */
  processRole: "api" | "worker" | "all";
  jobs: {
    /** "memory" (single-process, dev/test) or "bullmq" (Redis-backed, durable). */
    driver: "memory" | "bullmq";
    /** Grace period for in-flight jobs on shutdown before they are returned to the queue. */
    shutdownTimeoutMs: number;
  };
  flags: {
    /** Cross-instance change propagation: in-process only, or Redis pub/sub (issue #495). */
    pubsub: "memory" | "redis";
    /** Safety-net reload interval for the flag cache, in ms. */
    refreshMs: number;
    /** Hard pins that win over DB state, e.g. "onchain-dry-run=true". */
    overrides: string;
  };
  /** Raw ADMIN_API_KEYS value ("id:role:secret,..."); parsed by src/admin/admin-auth.ts. */
  adminApiKeys: string;
  /** Soroban contract emitting guardian emergency events (issue #507). Empty disables ingestion. */
  guardianContractId: string;
  /** Addresses (users and solvers) owned by the synthetic canary (issue #496). */
  canaryAddresses: string[];
  /** Public anonymised dataset publication settings (see docs/rfcs/0001). */
  datasets: {
    enabled: boolean;
    anonymize: boolean;
    salt: string;
    saltRotationHours: number;
    saltRetentionWindows: number;
    publicBucket: string;
    storageKind: "local" | "memory";
    localDir: string;
  };
  secrets: {
    /** Provider name: "env" | "aws-secrets-manager" | "vault-kv". */
    provider: "env" | "aws-secrets-manager" | "vault-kv";
    /** Poll interval for secret rotation (ms). */
    refreshIntervalMs: number;
    /** Comma-separated extra secrets: "name:envVar:required". */
    extra: string;
  /** WS gateway hardening (issue #455). */
  ws: {
    /** Largest inbound frame accepted; larger frames close the socket (1009). */
    maxPayloadBytes: number;
    /** Concurrent connections allowed from one client IP (0 = unlimited). */
    maxConnectionsPerIp: number;
    /** Reverse-proxy hops to trust when reading X-Forwarded-For (0 = use the socket address). */
    trustProxyHops: number;
    /** Inbound token bucket: sustained messages per second and burst size. */
    rateLimitPerSec: number;
    rateLimitBurst: number;
    /** Rate-limited messages tolerated before the connection is closed (1008). */
    rateLimitMaxViolations: number;
    /** Messages held for a slow consumer before the slow-consumer policy applies. */
    outboundQueueMax: number;
    /** Socket bufferedAmount above which further messages are queued instead of sent. */
    outboundBufferBytes: number;
    slowConsumerPolicy: "drop_oldest" | "disconnect";
    /** Drain timeout for graceful shutdown (Activity 2). */
    drainTimeoutMs: number;
  };
  /** HS256 secret for solver JWTs (SEP-10 auth, #442); empty disables JWT auth. */
  authJwtSecret: string;
  /**
   * How often (ms) the local rate-limiter fallback prunes expired window
   * entries (issue #441). Only relevant during a Redis outage.
   */
  rateLimitLocalPruneMs: number;
  /**
   * Redis URL backing the distributed rate limiter (issue #441). Empty means
   * "local bounded limiter only" — the limit is still enforced, just per
   * process. Defaults to `REDIS_URL` when that is set.
   */
  rateLimitRedisUrl: string;
  /**
   * Cross-replica transport for solver-credential revocation invalidation
   * (issue #443): "memory" (single instance) or "redis" (pub/sub).
   */
  credentialRevocationPubsub: "memory" | "redis";
  /** SSE intent feed (issue #433). */
  sse: {
    /** Heartbeat interval in milliseconds (SSE comment frames). */
    heartbeatMs: number;
    /** Maximum buffered output bytes per SSE client before it is disconnected. */
    maxBufferBytes: number;
  };
  /** Health probes (issue #492). */
  health: {
    /** Roles this process serves; readiness requires every indicator critical to any of them. */
    roles: Array<"api" | "ws" | "worker">;
    /** Background re-check interval; probes only read cached results. */
    checkIntervalMs: number;
    /** Consecutive failed evaluations before readiness turns false. */
    readyFailureThreshold: number;
    /** Consecutive passing evaluations before readiness turns true again. */
    readySuccessThreshold: number;
    /** Event-loop delay above which liveness fails. */
    eventLoopMaxLagMs: number;
    /** Soroban RPC endpoints probed for quorum (majority must be healthy). */
    rpcHealthUrls: string[];
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://vortex:vortex@localhost:5432/vortex?schema=public",
  stellar: {
    network: (process.env.STELLAR_NETWORK ?? "testnet") as AppConfig["stellar"]["network"],
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    settlementContractId: process.env.SETTLEMENT_CONTRACT_ID ?? "",
    solverRegistryContractId: process.env.SOLVER_REGISTRY_CONTRACT_ID ?? "",
    signerSecretKey: process.env.STELLAR_SIGNER_SECRET_KEY ?? "",
    signingKey: process.env.SOROBAN_SIGNING_KEY ?? "",
    feePercentile: (process.env.SOROBAN_FEE_PERCENTILE ?? "p50") as FeePercentile,
    maxFeeStroops: parseInt(process.env.SOROBAN_MAX_FEE_STROOPS ?? "1000000", 10),
    channelPoolSize: parseInt(process.env.CHANNEL_POOL_SIZE ?? "8", 10),
    channelSecretKeys: process.env.CHANNEL_SECRET_KEYS ?? "",
  },
  treasury: {
    address: process.env.TREASURY_ADDRESS ?? "",
  },
  onchainIntentsEnabled: (process.env.ONCHAIN_INTENTS_ENABLED ?? "false") === "true",
  legacyStellarSignatures:
    process.env.ALLOW_LEGACY_STELLAR_SIGNATURES === "true" || process.env.NODE_ENV === "test",
  evm: {
    rpcAllowlist: (process.env.EVM_RPC_ALLOWLIST ?? "").split(",").map((host) => host.trim()).filter(Boolean),
    chains: {
      ethereum: { chainId: 1, rpcUrl: process.env.ETHEREUM_RPC_URL ?? "", escrowAddress: process.env.ETHEREUM_ESCROW_ADDRESS ?? "" },
      base: { chainId: 8453, rpcUrl: process.env.BASE_RPC_URL ?? "", escrowAddress: process.env.BASE_ESCROW_ADDRESS ?? "" },
      polygon: { chainId: 137, rpcUrl: process.env.POLYGON_RPC_URL ?? "", escrowAddress: process.env.POLYGON_ESCROW_ADDRESS ?? "" },
      arbitrum: { chainId: 42161, rpcUrl: process.env.ARBITRUM_RPC_URL ?? "", escrowAddress: process.env.ARBITRUM_ESCROW_ADDRESS ?? "" },
      optimism: { chainId: 10, rpcUrl: process.env.OPTIMISM_RPC_URL ?? "", escrowAddress: process.env.OPTIMISM_ESCROW_ADDRESS ?? "" },
      avalanche: { chainId: 43114, rpcUrl: process.env.AVALANCHE_RPC_URL ?? "", escrowAddress: process.env.AVALANCHE_ESCROW_ADDRESS ?? "" },
    },
  },
  intentRetentionDays: parseInt(process.env.INTENT_RETENTION_DAYS ?? "30", 10),
  intentRetentionSweepMs: parseInt(process.env.INTENT_RETENTION_SWEEP_MS ?? "60000", 10),
  // Default to dry-run (true) outside production; in production the value must
  // be explicitly set (validated by envValidationSchema).
  onchainDryRun: process.env.ONCHAIN_DRY_RUN !== undefined
    ? process.env.ONCHAIN_DRY_RUN === "true"
    : process.env.NODE_ENV !== "production",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  wsMaxConnections: parseInt(process.env.WS_MAX_CONNECTIONS ?? "1000", 10),
  wsBackplane: (process.env.WS_BACKPLANE ?? "memory") as "memory" | "redis",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // ── Resource-exhaustion limits (issue #476) ───────────────────────────────
  jsonMaxDepth: parseInt(process.env.JSON_MAX_DEPTH ?? "10", 10),
  wsMaxFilterChains: parseInt(process.env.WS_MAX_FILTER_CHAINS ?? "20", 10),
  wsMaxSubscriptions: parseInt(process.env.WS_MAX_SUBSCRIPTIONS ?? "10", 10),
  dbQueryTimeoutMs: parseInt(process.env.DB_QUERY_TIMEOUT_MS ?? "5000", 10),
  dbBatchQueryTimeoutMs: parseInt(process.env.DB_BATCH_QUERY_TIMEOUT_MS ?? "10000", 10),
  dbStatsQueryTimeoutMs: parseInt(process.env.DB_STATS_QUERY_TIMEOUT_MS ?? "15000", 10),

  // ── Emergency kill-switch (issue #477) ─────────────────────────────────────
  killswitch: {
    operatorToken: process.env.KILLSWITCH_OPERATOR_TOKEN ?? "",
    // Reuse the WS backplane URL when set; an explicit empty value opts out of
    // Redis entirely and leaves propagation to database polling.
    redisUrl:
      process.env.KILLSWITCH_REDIS_URL ??
      (process.env.REDIS_URL && process.env.WS_BACKPLANE === "redis" ? process.env.REDIS_URL : ""),
    // 2000 ms + request latency stays well inside the 5 s propagation budget
    // even when Redis is unavailable.
    pollMs: parseInt(process.env.KILLSWITCH_POLL_MS ?? "2000", 10),
  },
  shadow: {
    // Off by default: the monitor costs one simulation per sampled transition,
    // so it is opt-in per environment rather than something a deployer
    // discovers they are paying for.
    enabled: (process.env.SHADOW_MODE_ENABLED ?? "false") === "true",
    sampleRate: clampSampleRate(process.env.SHADOW_SAMPLE_RATE),
    queueMax: clampPositiveInt(process.env.SHADOW_QUEUE_MAX, 256),
    concurrency: clampPositiveInt(process.env.SHADOW_CONCURRENCY, 4),
    sourceAccount: process.env.SHADOW_SOURCE_ACCOUNT ?? "",
  },
  governance: {
    paramsContractId: process.env.PARAMS_CONTRACT_ID ?? "",
    paramsPollIntervalMs: parseInt(process.env.PARAMS_POLL_INTERVAL_MS ?? "30000", 10),
  },
  leaderElection: {
    enabled: (process.env.LEADER_ELECTION_ENABLED ?? "false") === "true",
    heartbeatMs: parseInt(process.env.LEADER_ELECTION_HEARTBEAT_MS ?? "5000", 10),
  },
  processRole: (process.env.PROCESS_ROLE ?? "all") as AppConfig["processRole"],
  jobs: {
    driver: (process.env.JOBS_DRIVER ?? "memory") as AppConfig["jobs"]["driver"],
    shutdownTimeoutMs: parseInt(process.env.JOBS_SHUTDOWN_TIMEOUT_MS ?? "25000", 10),
  },
  flags: {
    pubsub: (process.env.FLAGS_PUBSUB ?? "memory") as AppConfig["flags"]["pubsub"],
    refreshMs: parseInt(process.env.FLAGS_REFRESH_MS ?? "30000", 10),
    overrides: process.env.FLAG_OVERRIDES ?? "",
  },
  adminApiKeys: process.env.ADMIN_API_KEYS ?? "",
  datasets: {
    enabled: (process.env.DATASETS_ENABLED ?? "false") === "true",
    anonymize: (process.env.DATASETS_ANONYMIZE ?? "true") === "true",
    salt: process.env.DATASETS_SALT ?? "",
    saltRotationHours: parseInt(process.env.DATASETS_SALT_ROTATION_HOURS ?? "24", 10),
    saltRetentionWindows: parseInt(process.env.DATASETS_SALT_RETENTION_WINDOWS ?? "2", 10),
    publicBucket: process.env.DATASETS_PUBLIC_BUCKET ?? "",
    storageKind: (process.env.DATASETS_STORAGE_KIND ?? "memory") as "local" | "memory",
    localDir: process.env.DATASETS_LOCAL_DIR ?? "",
  },
  guardianContractId: process.env.GUARDIAN_CONTRACT_ID ?? "",
  canaryAddresses: (process.env.CANARY_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean),
  datasets: {
    enabled: (process.env.DATASETS_ENABLED ?? "false") === "true",
    anonymize: (process.env.DATASETS_ANONYMIZE ?? "true") === "true",
    salt: process.env.DATASETS_SALT ?? "",
    saltRotationHours: parseInt(process.env.DATASETS_SALT_ROTATION_HOURS ?? "24", 10),
    saltRetentionWindows: parseInt(process.env.DATASETS_SALT_RETENTION_WINDOWS ?? "2", 10),
    publicBucket: process.env.DATASETS_PUBLIC_BUCKET ?? "vortex-public-datasets",
    storageKind: (process.env.DATASETS_STORAGE ?? "local") as "local" | "memory",
    localDir: process.env.DATASETS_LOCAL_DIR ?? ".datasets",
  },
  secrets: {
    provider: (process.env.SECRETS_PROVIDER ?? "env") as "env" | "aws-secrets-manager" | "vault-kv",
    refreshIntervalMs: parseInt(process.env.SECRETS_REFRESH_INTERVAL_MS ?? "60000", 10),
    extra: process.env.SECRETS_EXTRA ?? "",
  ws: {
    maxPayloadBytes: parseInt(process.env.WS_MAX_PAYLOAD_BYTES ?? "16384", 10),
    maxConnectionsPerIp: parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP ?? "20", 10),
    trustProxyHops: parseInt(process.env.WS_TRUST_PROXY_HOPS ?? "0", 10),
    rateLimitPerSec: Number(process.env.WS_RATE_LIMIT_PER_SEC ?? "10"),
    rateLimitBurst: parseInt(process.env.WS_RATE_LIMIT_BURST ?? "20", 10),
    rateLimitMaxViolations: parseInt(process.env.WS_RATE_LIMIT_MAX_VIOLATIONS ?? "5", 10),
    outboundQueueMax: parseInt(process.env.WS_OUTBOUND_QUEUE_MAX ?? "1000", 10),
    outboundBufferBytes: parseInt(process.env.WS_OUTBOUND_BUFFER_BYTES ?? "1048576", 10),
    slowConsumerPolicy: (process.env.WS_SLOW_CONSUMER_POLICY ?? "drop_oldest") as AppConfig["ws"]["slowConsumerPolicy"],
    drainTimeoutMs: parseInt(process.env.WS_DRAIN_TIMEOUT_MS ?? "25000", 10),
  },
  authJwtSecret: process.env.AUTH_JWT_SECRET ?? "",
  rateLimitLocalPruneMs: parseInt(process.env.RATE_LIMIT_LOCAL_PRUNE_MS ?? "60000", 10),
  // Redis URL for the distributed rate limiter. Defaults to REDIS_URL so an
  // existing multi-replica deployment keeps a global quota; set it explicitly
  // to "" to force the bounded local limiter (single-replica / test).
  rateLimitRedisUrl: process.env.RATE_LIMIT_REDIS_URL ?? process.env.REDIS_URL ?? "",
  credentialRevocationPubsub: (process.env.CREDENTIAL_REVOCATION_PUBSUB ?? "memory") as "memory" | "redis",
  sse: {
    heartbeatMs: parseInt(process.env.SSE_HEARTBEAT_MS ?? "15000", 10),
    maxBufferBytes: parseInt(process.env.SSE_MAX_BUFFER_BYTES ?? "1048576", 10),
  },
  health: {
    roles: (process.env.SERVICE_ROLES ?? "api,ws,worker")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean) as AppConfig["health"]["roles"],
    checkIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS ?? "5000", 10),
    readyFailureThreshold: parseInt(process.env.HEALTH_READY_FAILURE_THRESHOLD ?? "3", 10),
    readySuccessThreshold: parseInt(process.env.HEALTH_READY_SUCCESS_THRESHOLD ?? "2", 10),
    eventLoopMaxLagMs: parseInt(process.env.HEALTH_EVENT_LOOP_MAX_LAG_MS ?? "1000", 10),
    rpcHealthUrls: (process.env.SOROBAN_RPC_HEALTH_URLS || process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
  },
});

/** Parse `SHADOW_SAMPLE_RATE` into a probability, defaulting to full sampling. */
function clampSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

/**
 * Parse a positive integer env var, falling back to `fallback` for anything
 * unparseable or non-positive. Keeps a typo from turning the bounded queue
 * into an unbounded one.
 */
function clampPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}
