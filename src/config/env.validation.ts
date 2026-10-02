import * as Joi from "joi";

// Stellar secret seeds ("S..." strkeys) are 56-char base32: prefix + 32-byte
// payload + checksum. This rejects placeholders like "changeme" outright —
// it does not by itself prove the key is a *real, funded* signer.
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

// One message for both "absent" and "empty". Joi's .required() alone accepts an
// empty string, which for the kill-switch would be a silently disabled control
// plane — the exact condition this rule exists to prevent, so both cases must
// produce the same actionable error.
const KILLSWITCH_TOKEN_REQUIRED_MESSAGE =
  "KILLSWITCH_OPERATOR_TOKEN must be a non-empty secret in production so the " +
  "emergency pause control plane (/api/v1/ops/killswitch) is usable. Generate " +
  "one with `openssl rand -hex 32`. See docs/runbooks/killswitch.md.";

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(4000),

  // Prisma requires DATABASE_URL in production; optional (with a default) in
  // development/test so the app can boot without a live database for unit tests.
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgresql", "postgres"] })
    .default("postgresql://vortex:vortex@localhost:5432/vortex?schema=public"),

  // ── #411 — Read replicas ─────────────────────────────────────────────────
  // Comma-separated Postgres connection strings for read replicas.
  // Leave blank to route all reads to the primary.
  DATABASE_REPLICA_URLS: Joi.string().allow("").default(""),
  // Maximum replica replication lag (ms) before a replica is bypassed.
  MAX_REPLICA_LAG_MS: Joi.number().integer().min(100).max(60000).default(5000),

  STELLAR_NETWORK: Joi.string().valid("testnet", "futurenet", "mainnet").default("testnet"),
  SOROBAN_RPC_URL: Joi.string().uri().default("https://soroban-testnet.stellar.org"),
  // Horizon base URL, used for account/balance reads (treasury, canary tooling).
  HORIZON_URL: Joi.string().uri().default("https://horizon-testnet.stellar.org"),
  SETTLEMENT_CONTRACT_ID: Joi.string().allow("").default(""),
  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().allow("").default(""),
  STELLAR_SIGNER_SECRET_KEY: Joi.string().allow("").default(""),

  // Secret key for the backend's own Soroban signer (submits on-chain writes
  // such as settlement and slashing calls). No default is provided anywhere
  // in this schema — an unset value fails closed (empty string) rather than
  // ever falling back to a placeholder that could be mistaken for a real key.
  SOROBAN_SIGNING_KEY: Joi.string()
    .pattern(STELLAR_SECRET_KEY_PATTERN)
    .messages({
      "string.pattern.base":
        'SOROBAN_SIGNING_KEY must be a valid Stellar secret seed (starts with "S", 56 base32 characters). ' +
        "Generate a throwaway testnet key for local dev — see README's Signing Key section — never commit a real one.",
    })
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().allow("").default(""),
    }),

  ONCHAIN_INTENTS_ENABLED: Joi.boolean().default(false),
  // Stellar public key of the treasury account (fee/slash/refund accumulator).
  TREASURY_ADDRESS: Joi.string().allow("").default(""),

  ALLOW_LEGACY_STELLAR_SIGNATURES: Joi.boolean().default(false),
  ETHEREUM_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  ETHEREUM_ESCROW_ADDRESS: Joi.string().pattern(/^$|^0x[a-fA-F0-9]{40}$/).default(""),
  BASE_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  BASE_ESCROW_ADDRESS: Joi.string().pattern(/^$|^0x[a-fA-F0-9]{40}$/).default(""),
  POLYGON_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  POLYGON_ESCROW_ADDRESS: Joi.string().pattern(/^$|^0x[a-fA-F0-9]{40}$/).default(""),
  ARBITRUM_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  ARBITRUM_ESCROW_ADDRESS: Joi.string().pattern(/^$|^0x[a-fA-F0-9]{40}$/).default(""),
  OPTIMISM_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  OPTIMISM_ESCROW_ADDRESS: Joi.string().pattern(/^$|^0x[a-fA-F0-9]{40}$/).default(""),
  AVALANCHE_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  AVALANCHE_ESCROW_ADDRESS: Joi.string().pattern(/^$|^0x[a-fA-F0-9]{40}$/).default(""),
  EVM_RPC_ALLOWLIST: Joi.string().allow("").default(""),
  CORS_ORIGIN: Joi.string().default("*"),
  WS_MAX_CONNECTIONS: Joi.number().integer().min(0).default(1000),
  SOROBAN_FEE_PERCENTILE: Joi.string()
    .valid(
      "min",
      "mode",
      "p10",
      "p20",
      "p30",
      "p40",
      "p50",
      "p60",
      "p70",
      "p80",
      "p90",
      "p95",
      "p99",
      "max",
    )
    .default("p50"),

  WS_BACKPLANE: Joi.string().valid("memory", "redis").default("memory"),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).default("redis://localhost:6379"),

  // ── WebSocket replay store (issue #457) ───────────────────────────────────
  // WS_REPLAY_MAX_AGE_MS stays optional-by-omission (commented in the
  // .env examples) and is read directly where the buffer is built.
  WS_REPLAY_STORE: Joi.string().valid("memory", "redis").default("memory"),
  WS_REPLAY_MAX_COUNT: Joi.number().integer().min(1).default(500),

  // ── Persistence adapter selection ─────────────────────────────────────────
  // Controls which repository adapter is used for intents and solvers.
  // "memory" (default) keeps everything in-process — no database required.
  // "prisma" writes to PostgreSQL via Prisma — requires DATABASE_URL to point
  // to a live database.  Intended for production / staging.
  INTENTS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),
  SOLVERS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

  // ── Intent retention (in-memory store hygiene) ─────────────────────────────
  // How long terminal intents are kept in the in-memory adapter, and how often
  // the eviction sweep runs.  Both are read by IntentsService.
  INTENT_RETENTION_DAYS: Joi.number().integer().min(0).default(30),
  INTENT_RETENTION_SWEEP_MS: Joi.number().integer().min(0).default(60000),

  // ── Reference solver bot (scripts/solver-bot.ts) ───────────────────────────
  // Read by the standalone bot process rather than by the server, but declared
  // here so `npm run check:env-drift` sees one consistent variable set across
  // env.validation.ts, configuration.ts and the .env*.example files.
  SOLVER_SECRET: Joi.string().allow("").default(""),
  SOLVER_ADDRESS: Joi.string().allow("").default(""),
  SOLVER_CHAINS: Joi.string().allow("").default(""),

  // ── Observability ─────────────────────────────────────────────────────────
  // Sentry DSN for error alerting.  Omit (or leave blank) to disable Sentry.
  SENTRY_DSN: Joi.string().uri().allow("").default(""),

  // Bearer token that guards GET /metrics (issue #298).
  // When set, Prometheus scrape jobs must supply:
  //   Authorization: Bearer <METRICS_TOKEN>
  // When empty (the default):
  //   - non-production: unauthenticated scraping allowed (local dev Prometheus)
  //   - production: rejected at boot — #298 requires a non-empty token of at
  //     least 16 characters so a deploy can never expose /metrics without
  //     authentication (fail closed at validation time, not at scrape time).
  // Generate with: openssl rand -hex 32
  METRICS_TOKEN: Joi.string()
    .when("NODE_ENV", {
      is: Joi.valid("production"),
      then: Joi.string().required().invalid("").min(16),
      otherwise: Joi.string().allow("").default(""),
    }),

  // Winston log level.  Defaults to "debug" in dev/test and "info" in production.
  LOG_LEVEL: Joi.string()
    .valid("error", "warn", "info", "http", "verbose", "debug", "silly")
    .default(
      // Joi.ref doesn't evaluate lazily here, so we rely on the logger's own
      // resolveLogLevel() for the runtime default — this schema default acts
      // as a documentation hint and config validation guard only.
      "debug",
    ),

  // Log shipping — off by default so local dev/CI remain stdout-only. When
  // enabled, structured logs are also shipped to LOG_SHIPPING_HOST:PORT.
  LOG_SHIPPING_ENABLED: Joi.boolean().default(false),
  LOG_SHIPPING_HOST: Joi.string().when("LOG_SHIPPING_ENABLED", {
    is: true,
    then: Joi.required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  LOG_SHIPPING_PORT: Joi.number().port().when("LOG_SHIPPING_ENABLED", {
    is: true,
    then: Joi.required(),
    otherwise: Joi.number().optional(),
  }),
  LOG_SHIPPING_PATH: Joi.string().default("/"),
  LOG_SHIPPING_SSL: Joi.boolean().default(false),
  LOG_SERVICE_NAME: Joi.string().default("vortex-backend"),

  // ── Pluggable signer backend (issue #400) ────────────────────────────────
  // SIGNER_BACKEND selects which signing implementation is used:
  //   "local"  (default) — LocalKeypairSigner: key loaded from SOROBAN_SIGNING_KEY / file.
  //                        Refused in production unless ALLOW_LOCAL_SIGNER_IN_PROD=true.
  //   "vault"            — VaultTransitSigner: signs via HashiCorp Vault Transit (ed25519).
  //                        Requires VAULT_ADDR + VAULT_TOKEN.  Key never enters RAM.
  SIGNER_BACKEND: Joi.string().valid("local", "vault").default("local"),

  // Required when SIGNER_BACKEND=vault.
  VAULT_ADDR: Joi.string().uri({ scheme: ["http", "https"] }).when("SIGNER_BACKEND", {
    is: "vault",
    then: Joi.required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  VAULT_TOKEN: Joi.string().when("SIGNER_BACKEND", {
    is: "vault",
    then: Joi.required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  // Name of the Vault Transit key (default: "vortex-signer").
  VAULT_TRANSIT_KEY_NAME: Joi.string().default("vortex-signer"),

  // Escape hatch: allow LocalKeypairSigner in production.
  // Must be explicitly set to "true" — any other value is treated as false.
  // A startup warning is emitted when this is enabled in production.
  ALLOW_LOCAL_SIGNER_IN_PROD: Joi.boolean().default(false),
  
  // ── Resource-exhaustion limits (issue #476) ───────────────────────────────
  // These values are consumed by src/config/limits.config.ts at startup and
  // override the compile-time defaults when set.  All have safe defaults so
  // the service can boot without them.

  /** Max JSON nesting depth before the body is rejected (default 10). */
  JSON_MAX_DEPTH: Joi.number().integer().min(1).max(100).default(10),

  /** Max WS chain-filter values per subscribe message (default 20). */
  WS_MAX_FILTER_CHAINS: Joi.number().integer().min(1).max(100).default(20),

  /** Max active subscriptions per WS connection (default 10). */
  WS_MAX_SUBSCRIPTIONS: Joi.number().integer().min(1).max(100).default(10),

  /** Default Postgres statement_timeout in ms for standard route queries (default 5000). */
  DB_QUERY_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(5000),

  /** Postgres statement_timeout in ms for batch-lookup queries (default 10000). */
  DB_BATCH_QUERY_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(10000),

  /** Postgres statement_timeout in ms for stats/aggregate queries (default 15000). */
  DB_STATS_QUERY_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(15000),

  // ── Emergency kill-switch (issue #477) ─────────────────────────────────────
  // Shared secret for the operator control plane. Empty (the default) leaves
  // /api/v1/ops/killswitch disabled — fail closed, never open.
  //
  // The kill-switch is the only way to stop writes at runtime, so a production
  // deploy without a token ships a protocol that cannot be paused. Requiring it
  // in production fails validation rather than silently running with the
  // control plane disabled.
  KILLSWITCH_OPERATOR_TOKEN: Joi.string()
    .when("NODE_ENV", {
      is: Joi.valid("production"),
      then: Joi.string()
        .required()
        .invalid("")
        .messages({
          "any.required": KILLSWITCH_TOKEN_REQUIRED_MESSAGE,
          "string.empty": KILLSWITCH_TOKEN_REQUIRED_MESSAGE,
          "any.invalid": KILLSWITCH_TOKEN_REQUIRED_MESSAGE,
        }),
      otherwise: Joi.string().allow("").default(""),
    }),

  /**
   * Redis URL for cross-replica pause propagation. Empty means "polling only",
   * which still meets the 5 s budget. Defaults to reusing REDIS_URL when
   * WS_BACKPLANE=redis, so existing deployments propagate without new config.
   */
  KILLSWITCH_REDIS_URL: Joi.string().allow("").optional(),

  /**
   * DB change-probe interval (ms) that backstops Redis pub/sub. Capped at 5000
   * so the worst-case propagation delay cannot exceed the requirement, however
   * misconfigured.
   */
  KILLSWITCH_POLL_MS: Joi.number().integer().min(100).max(5000).default(2000),

  // Same adapter-selection convention as the other repositories.
  KILLSWITCH_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

  // ── On-chain write safety flag (issue #35 / issue #260) ──────────────────
  // When true, every on-chain-write code path (invokeContract, slashSolver)
  // builds and simulates the transaction, logs what it *would* submit, and
  // returns without broadcasting — safe by construction.
  //
  // Default behaviour:
  //   - Outside production: defaults to true (simulate-only, fail closed
  //     toward safety — no real funds moved without an explicit opt-out).
  //   - In production: *required* to be explicitly set.  Omitting it in a
  //     production deploy fails validation so the operator must consciously
  //     decide between dry-run and live mode before traffic reaches
  //     on-chain write paths.  This matches the fail-closed pattern used
  //     for SOROBAN_SIGNING_KEY.
  //
  // This is the env default for the `onchain-dry-run` runtime feature flag
  // (issue #495); the flag can override it without a restart, and turning
  // dry-run off in production through the flag requires two approvals.
  // Set ONCHAIN_DRY_RUN=false only after completing the dry-run soak
  // described in docs/runbooks/onchain-cutover.md.
  ONCHAIN_DRY_RUN: Joi.boolean()
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required().messages({
        "any.required":
          "ONCHAIN_DRY_RUN must be explicitly set in production. " +
          "Set to true to remain in simulate-only mode, or false to enable live on-chain writes. " +
          "See docs/runbooks/onchain-cutover.md for the staged rollout procedure.",
      }),
      otherwise: Joi.boolean().default(true),
    }),

  // ── Shadow-mode divergence monitor (issue #401) ───────────────────────────
  // Runs read-only on-chain simulations of every intent state transition in
  // parallel with the authoritative off-chain path and reports where the two
  // disagree.  Never submits a transaction; see src/soroban/shadow.service.ts.
  //
  // Off by default: a sampled simulation is a real RPC call with a real
  // rate-limit footprint, so it is an explicit per-environment opt-in.
  SHADOW_MODE_ENABLED: Joi.boolean().default(false),

  // Fraction of transitions to simulate, as a probability in [0, 1].
  // 1 (the default) compares every transition; 0 disables sampling entirely
  // while leaving the monitor "enabled" — useful for a canary that only wants
  // the queue/metric plumbing live.
  SHADOW_SAMPLE_RATE: Joi.number().min(0).max(1).default(1),

  // Hard cap on queued observations.  Beyond this, observations are dropped and
  // counted (`vortex_shadow_dropped_total`) rather than queued, so a slow or
  // unreachable RPC degrades the monitor instead of the service.
  SHADOW_QUEUE_MAX: Joi.number().integer().min(1).default(256),

  // How many queued observations the background drain simulates concurrently.
  SHADOW_CONCURRENCY: Joi.number().integer().min(1).max(32).default(4),

  // Public key used as the transaction source for shadow simulations.  A Stellar
  // public key (strkey G...).  It is never signed, never submitted and never
  // charged a fee — it only has to be a valid address for the envelope.
  // Optional: when empty the monitor reports `contract_unconfigured` rather
  // than silently recording zero divergence.
  SHADOW_SOURCE_ACCOUNT: Joi.string().allow("").default(""),
  
  // ── Governance parameters contract ────────────────────────────────────────
  // When set, ProtocolParamsService reads current + scheduled protocol
  // parameters (fee bps, fill windows, deadlines, exposure ratio, slash
  // amount) from this Soroban contract address.  Leave blank to use code
  // and env defaults.
  PARAMS_CONTRACT_ID: Joi.string().allow("").default(""),

  // How often (ms) to poll the parameters contract.  30 s is the default;
  // lower values increase RPC load; raise in production if rate-limited.
  PARAMS_POLL_INTERVAL_MS: Joi.number().integer().min(5_000).default(30_000),
  
  // ── Leader election (issue #493) ──────────────────────────────────────────
  // Controls whether Postgres advisory-lock based leader election is enabled
  // for singleton workers (sweeper, event-ingestion).
  //
  // Set LEADER_ELECTION_ENABLED=false in single-instance dev deployments or
  // when no database is available. When disabled, every worker considers
  // itself leader unconditionally — the pre-election behaviour.
  //
  // IMPORTANT: Do NOT route the leader election connection through PgBouncer
  // in transaction-pooling mode. Advisory locks are session-scoped; they are
  // released when the connection is returned to the pool. Use a direct
  // connection or PgBouncer in session mode.
  LEADER_ELECTION_ENABLED: Joi.boolean().default(false),

  // Heartbeat interval in milliseconds — how often non-leaders attempt to
  // acquire the lock and leaders renew it. Lower values reduce failover time
  // but increase DB load. Default 5 s gives ≤ 15 s failover.
  LEADER_ELECTION_HEARTBEAT_MS: Joi.number().integer().min(1000).max(60000).default(5000),

  // ── Background jobs (issue #494) ──────────────────────────────────────────
  // PROCESS_ROLE: "api" serves HTTP/WS only, "worker" runs queue workers,
  // "all" does both (single-process dev default). Producers work in any role.
  PROCESS_ROLE: Joi.string().valid("api", "worker", "all").default("all"),
  // JOBS_DRIVER: "memory" is single-process and non-durable (dev/test);
  // "bullmq" uses REDIS_URL and is required for multi-instance deploys.
  JOBS_DRIVER: Joi.string().valid("memory", "bullmq").default("memory"),
  JOBS_SHUTDOWN_TIMEOUT_MS: Joi.number().integer().min(0).default(25000),

  // ── Runtime feature flags (issue #495) ────────────────────────────────────
  FLAGS_PUBSUB: Joi.string().valid("memory", "redis").default("memory"),
  FLAGS_REFRESH_MS: Joi.number().integer().min(1000).default(30000),
  // Comma-separated "key=true|false" pins that win over DB state (break-glass).
  FLAG_OVERRIDES: Joi.string()
    .allow("")
    .pattern(/^([a-z0-9-]+=(true|false))(,[a-z0-9-]+=(true|false))*$/)
    .default(""),

  // ── Admin RBAC ────────────────────────────────────────────────────────────
  // Comma-separated "id:role:secret" entries; role is "admin" or "superadmin".
  // Empty disables every admin endpoint (401).
  ADMIN_API_KEYS: Joi.string()
    .allow("")
    .pattern(/^([A-Za-z0-9_.-]+:(admin|superadmin):[^,:]{16,})(,[A-Za-z0-9_.-]+:(admin|superadmin):[^,:]{16,})*$/)
    .default(""),

  // ── Public anonymised datasets ────────────────────────────────────────────
  // Legacy storage-backend selector (superseded by DATASETS_STORAGE below,
  // still exported by the .env*.example files).
  DATASETS_STORAGE_KIND: Joi.string().valid("local", "memory").default("memory"),

  // ── Guardian emergency ingestion (issue #507) ─────────────────────────────
  GUARDIAN_CONTRACT_ID: Joi.string().allow("").default(""),

  // ── Synthetic canary (issue #496) ─────────────────────────────────────────
  // Comma-separated canary user/solver addresses, excluded from public stats
  // and leaderboards.
  CANARY_ADDRESSES: Joi.string().allow("").default(""),

  // ── Public anonymised datasets (docs/rfcs/0001) ───────────────────────────
  DATASETS_ENABLED: Joi.boolean().default(false),
  DATASETS_ANONYMIZE: Joi.boolean().default(true),
  // Required only when datasets are enabled AND anonymisation is on — an
  // empty/weak salt would collapse pseudonymisation to a fixed, reversible
  // transform.  It stays optional (default "") otherwise so existing dev/test
  // configs are unaffected.
  DATASETS_SALT: Joi.string()
    .when("DATASETS_ENABLED", {
      is: true,
      then: Joi.string().when("DATASETS_ANONYMIZE", {
        is: true,
        then: Joi.string()
          .min(32)
          .required()
          .messages({
            "any.required":
              "DATASETS_SALT must be set when DATASETS_ENABLED=true and DATASETS_ANONYMIZE=true. " +
              "Generate a strong random secret (e.g. `openssl rand -hex 32`).",
            "string.min": "DATASETS_SALT must be at least 32 characters.",
          }),
        otherwise: Joi.string().allow("").default(""),
      }),
      otherwise: Joi.string().allow("").default(""),
    }),
  DATASETS_SALT_ROTATION_HOURS: Joi.number().integer().min(1).default(24),
  DATASETS_SALT_RETENTION_WINDOWS: Joi.number().integer().min(0).default(2),
  DATASETS_PUBLIC_BUCKET: Joi.string().default("vortex-public-datasets"),
  DATASETS_STORAGE: Joi.string().valid("local", "memory").default("local"),
  DATASETS_LOCAL_DIR: Joi.string().default(".datasets"),

  // ── #412 — Cursor HMAC secret ──────────────────────────────────────────────
  // HMAC-SHA256 key used to sign opaque pagination cursors.
  // Generate with: openssl rand -hex 32
  CURSOR_HMAC_SECRET: Joi.string().allow("").default("dev-cursor-hmac-secret-do-not-use-in-prod"),

  // ── #413 — Cold-storage archival ───────────────────────────────────────────
  ARCHIVAL_ENABLED: Joi.boolean().default(false),
  ARCHIVAL_BUCKET_NAME: Joi.string().default("vortex-archives"),
  ARCHIVAL_S3_ENDPOINT: Joi.string().allow("").default(""),
  ARCHIVAL_S3_REGION: Joi.string().default("us-east-1"),
  ARCHIVAL_S3_ACCESS_KEY_ID: Joi.string().allow("").default(""),
  ARCHIVAL_S3_SECRET_ACCESS_KEY: Joi.string().allow("").default(""),
  ARCHIVAL_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
  ARCHIVAL_PARTITION_PREFIX: Joi.string().default("date="),
  ARCHIVAL_MAX_ROWS_PER_FILE: Joi.number().integer().min(1000).default(100000),
  // ── Secrets Manager (issue #465) ────────────────────────────────────────────
  SECRETS_PROVIDER: Joi.string().valid("env", "aws-secrets-manager", "vault-kv").default("env"),
  SECRETS_REFRESH_INTERVAL_MS: Joi.number().integer().min(5000).default(60000),
  SECRETS_EXTRA: Joi.string().allow("").default(""),

  // AWS Secrets Manager
  AWS_SECRETS_MANAGER_PREFIX: Joi.string().allow("").default(""),
  AWS_SECRETS_MANAGER_POLL_INTERVAL_MS: Joi.number().integer().min(5000).default(60000),

  // Vault KV
  VAULT_KV_MOUNT: Joi.string().default("secret"),
  VAULT_KV_PREFIX: Joi.string().default("vortex/"),
  VAULT_KV_POLL_INTERVAL_MS: Joi.number().integer().min(5000).default(60000),

  // Extra secret env vars referenced by the default SecretConfig
  JWT_SIGNING_KEY: Joi.string().allow("").default(""),
  WEBHOOK_SECRET: Joi.string().allow("").default(""),
  CHANNEL_KEY: Joi.string().allow("").default(""),
  // ── Egress / SSRF Protection (issue #468) ─────────────────────────────────
  // Controls the centralized HttpEgressService used for all outbound HTTP requests
  // (RPC, Horizon, oracles, webhooks) to prevent SSRF attacks.
  EGRESS_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(10000),
  EGRESS_MAX_REDIRECTS: Joi.number().integer().min(0).max(5).default(3),
  EGRESS_MAX_BODY_SIZE_BYTES: Joi.number().integer().min(1024).default(10485760), // 10MB
  SOROBAN_RPC_ALLOWLIST: Joi.string().allow("").default(""),
  WEBHOOK_ALLOWLIST: Joi.string().allow("").default(""),
  ORACLE_ALLOWLIST: Joi.string().allow("").default(""),

  // ── WS gateway hardening (issue #455) ─────────────────────────────────────
  WS_MAX_PAYLOAD_BYTES: Joi.number().integer().min(1024).default(16384),
  WS_MAX_CONNECTIONS_PER_IP: Joi.number().integer().min(0).default(20),
  // Hops of trusted reverse proxies in front of the service. 0 ignores
  // X-Forwarded-For entirely so clients cannot spoof their IP.
  WS_TRUST_PROXY_HOPS: Joi.number().integer().min(0).default(0),
  WS_RATE_LIMIT_PER_SEC: Joi.number().positive().default(10),
  WS_RATE_LIMIT_BURST: Joi.number().integer().min(1).default(20),
  WS_RATE_LIMIT_MAX_VIOLATIONS: Joi.number().integer().min(1).default(5),
  WS_OUTBOUND_QUEUE_MAX: Joi.number().integer().min(1).default(1000),
  WS_OUTBOUND_BUFFER_BYTES: Joi.number().integer().min(1024).default(1048576),
  WS_SLOW_CONSUMER_POLICY: Joi.string().valid("drop_oldest", "disconnect").default("drop_oldest"),
  // HS256 secret shared with the SEP-10 auth endpoint (#442). Empty disables
  // JWT auth; signature auth keeps working.
  AUTH_JWT_SECRET: Joi.string().allow("").min(32).default(""),

  // ── Distributed rate limiting (issue #441) ─────────────────────────────────
  // How often the local rate-limiter fallback prunes expired window entries.
  // Only relevant during a Redis outage; keeps the fallback map bounded.
  RATE_LIMIT_LOCAL_PRUNE_MS: Joi.number().integer().min(1000).max(60000).default(60000),

  // Redis URL for the distributed rate limiter (#441). Leave empty to force the
  // bounded local limiter (the limit is still enforced, per process).
  RATE_LIMIT_REDIS_URL: Joi.string().allow("").optional(),

  // ── Scoped solver credentials (issue #443) ─────────────────────────────────
  // Cross-replica transport for credential revocation invalidation.
  CREDENTIAL_REVOCATION_PUBSUB: Joi.string().valid("memory", "redis").default("memory"),

  // ── SSE intent feed (issue #433) ───────────────────────────────────────────
  // Heartbeat comment interval and per-client backpressure limit for the
  // Server-Sent Events intent stream.
  SSE_HEARTBEAT_MS: Joi.number().integer().min(1000).max(60000).default(15000),
  SSE_MAX_BUFFER_BYTES: Joi.number().integer().min(1024).default(1048576),

  // ── Health probes (issue #492) ────────────────────────────────────────────
  // Comma-separated roles this process serves: api, ws, worker.
  SERVICE_ROLES: Joi.string()
    .pattern(/^(api|ws|worker)(,(api|ws|worker))*$/)
    .default("api,ws,worker"),
  HEALTH_CHECK_INTERVAL_MS: Joi.number().integer().min(500).default(5000),
  HEALTH_READY_FAILURE_THRESHOLD: Joi.number().integer().min(1).default(3),
  HEALTH_READY_SUCCESS_THRESHOLD: Joi.number().integer().min(1).default(2),
  HEALTH_EVENT_LOOP_MAX_LAG_MS: Joi.number().integer().min(50).default(1000),
  // Comma-separated Soroban RPC URLs for the RPC-quorum readiness check.
  // Defaults to SOROBAN_RPC_URL.
  SOROBAN_RPC_HEALTH_URLS: Joi.string().allow("").default(""),

  // ── Soroban RPC pool & archival (#509 #510) ───────────────────────────────
  // Comma-separated Soroban RPC endpoints; falls back to SOROBAN_RPC_URL.
  SOROBAN_RPC_URLS: Joi.string().allow("").default(""),
  // Optional archival RPC used for ledger-entry history reads.
  ARCHIVAL_RPC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").default(""),
  // Signing channel pool sizing for concurrent on-chain submissions.
  CHANNEL_POOL_SIZE: Joi.number().integer().min(1).max(64).default(8),
  // Comma-separated secret seeds, one per signing channel.
  CHANNEL_SECRET_KEYS: Joi.string().allow("").default(""),
  // Fee ceiling for on-chain submissions, in stroops.
  SOROBAN_MAX_FEE_STROOPS: Joi.number().integer().min(0).default(1000000),
  // Seconds after which a stale reconcile cursor triggers a rescan.
  RECONCILE_STALE_SECONDS: Joi.number().integer().min(1).default(300),

  // ── Postgres intents store (#404 #405) ────────────────────────────────────
  // Backend for persisted intents: in-memory or Postgres-backed.
  INTENTS_STORE: Joi.string().valid("memory", "postgres").default("memory"),
  // Interval between background verification passes over the stored intents.
  INTENTS_VERIFY_INTERVAL_MS: Joi.number().integer().min(1000).default(60000),

  // ── Oracle fair-value validation (#548) ───────────────────────────────────
  // Max quote slippage versus oracle fair value before a quote is rejected.
  MAX_USER_SLIPPAGE_BPS: Joi.number().integer().min(0).default(100),
  // Max premium over fair value a solver may quote before rejection.
  MAX_PREMIUM_BPS: Joi.number().integer().min(0).default(50),
  // Oracle staleness tolerance before prices are considered unusable.
  ORACLE_MAX_STALENESS_MS: Joi.number().integer().min(1000).default(60000),
  // Aggregate USD value for which a stale feed fails open instead of closed.
  ORACLE_FAIL_OPEN_MAX_USD: Joi.number().min(0).default(100),

  // ── Transactional outbox (#396 #397) ──────────────────────────────────────
  OUTBOX_RELAY_ENABLED: Joi.boolean().default(true),
  OUTBOX_RELAY_INTERVAL_MS: Joi.number().integer().min(100).default(2000),
  OUTBOX_RELAY_BATCH_SIZE: Joi.number().integer().min(1).default(10),
  OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).default(8),
  OUTBOX_LEASE_SECONDS: Joi.number().integer().min(1).default(120),

  // ── Durable slashing saga (#396 #397) ─────────────────────────────────────
  SLASH_CHALLENGE_WINDOW_SECONDS: Joi.number().integer().min(0).default(600),
  SLASH_CLOCK_SKEW_TOLERANCE_SECONDS: Joi.number().integer().min(0).default(30),
  SLASH_MAX_SUBMIT_ATTEMPTS: Joi.number().integer().min(1).default(5),

  // ── Protocol fees (#551) ──────────────────────────────────────────────────
  // JSON array of versioned fee rules applied when quoting swaps.
  FEE_RULES_JSON: Joi.string().default("[]"),
  // JSON array of referral-configured fee overrides.
  FEE_REFERRALS_JSON: Joi.string().default("[]"),

  // ── EVM deposit verification (#402-#405) ──────────────────────────────────
  EVM_DEPOSIT_VERIFICATION_ENABLED: Joi.boolean().default(false),
  // JSON object mapping chain id to RPC URL (e.g. {"1":"https://..."}).
  EVM_RPC_URLS: Joi.string().default("{}"),
  // Comma-separated escrow contract addresses accepted for deposits.
  EVM_ESCROW_ADDRESSES: Joi.string().allow("").default(""),
  EVM_TRANSFER_FEE_TOLERANCE_BPS: Joi.number().integer().min(0).default(0),
  EVM_LOG_LOOKBACK_BLOCKS: Joi.number().integer().min(0).default(10000),

  // ── Maintenance sweeps & WS shutdown (#547 #511) ──────────────────────────
  // Interval for the background safety sweep over stuck intents.
  SAFETY_SWEEP_INTERVAL_MS: Joi.number().integer().min(1000).default(300000),
  // Grace period for draining open WebSocket connections on shutdown.
  WS_DRAIN_TIMEOUT_MS: Joi.number().integer().min(0).default(25000),

  // ── Token persistence & price feed (issues #565 #566) ─────────────────────
  // Repository backend for the token catalogue: "memory" (default, tests and
  // single-process dev) or "prisma" (postgres-backed, restart-surviving).
  TOKENS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),
  // JSON object mapping token symbols to CoinGecko IDs, e.g. {"BTC":"bitcoin"}.
  PRICE_FEED_COIN_IDS: Joi.string().default("{}"),
  // Optional CoinGecko Pro key; empty falls back to the free-tier rate limits.
  PRICE_FEED_API_KEY: Joi.string().allow("").default(""),
  PRICE_FEED_REFRESH_INTERVAL_MS: Joi.number().integer().min(10_000).default(60_000),
  // Single-tick move (%) above which the circuit breaker pauses refreshes.
  PRICE_FEED_CIRCUIT_BREAKER_THRESHOLD_PERCENT: Joi.number().min(1).max(100).default(50),

  // ── RFQ quote auction (issue #570) ────────────────────────────────────────
  // Milliseconds solvers get to respond to a quote request before the
  // auction window closes.
  QUOTE_AUCTION_WINDOW_MS: Joi.number().integer().min(50).default(300),

  // ── Solver reputation (issue #444) ────────────────────────────────────────
  // Weights for each reputation sub-component. Must sum to 1 in production
  // (fail closed if misconfigured); in dev/test the app renormalises and
  // logs a warning so local experimentation doesn't prevent boot.
  REP_WEIGHT_FILL_RATE: Joi.number().min(0).max(1).default(0.35),
  REP_WEIGHT_LATENCY: Joi.number().min(0).max(1).default(0.15),
  REP_WEIGHT_SLASHES: Joi.number().min(0).max(1).default(0.25),
  REP_WEIGHT_QUOTE_HONOUR: Joi.number().min(0).max(1).default(0.15),
  REP_WEIGHT_VOLUME: Joi.number().min(0).max(1).default(0.10),
  // Shared exponential-decay half-life for all event weights.
  // Defaults to 30 days so scores are dominated by the last ~1 month.
  REP_DECAY_HALFLIFE_SECONDS: Joi.number()
    .integer()
    .min(86400)
    .default(30 * 24 * 60 * 60),
  // Beta-distribution priors for the fill-rate Bayesian cold-start prior.
  // (α=4, β=1) gives a ~80% prior mean so new solvers rank above poor
  // established performers rather than at the very bottom.
  REP_BAYES_ALPHA: Joi.number().min(0.5).default(4),
  REP_BAYES_BETA: Joi.number().min(0.5).default(1),
  // Volume-component knee scale, in USD-equivalent notional.
  // $100k default: moving from $10k → $100k of decayed volume accounts
  // for ~0.5 of the normalised volume score.
  REP_VOLUME_LAMBDA_USD: Joi.number().min(1).default(100000),
  // How many trailing days of daily snapshots the /reputation endpoint
  // returns. 1..365; default 30.
  REP_HISTORY_WINDOW_DAYS: Joi.number().integer().min(1).max(365).default(30),
}).custom((value, helpers) => {
  const wSum =
    (value.REP_WEIGHT_FILL_RATE ?? 0) +
    (value.REP_WEIGHT_LATENCY ?? 0) +
    (value.REP_WEIGHT_SLASHES ?? 0) +
    (value.REP_WEIGHT_QUOTE_HONOUR ?? 0) +
    (value.REP_WEIGHT_VOLUME ?? 0);
  // Require exact-within-tolerance only in production. Dev/test accept any
  // weights and let configuration.ts renormalise them.
  if (value.NODE_ENV === "production" && Math.abs(wSum - 1) > 1e-9) {
    return helpers.message({
      custom:
        `Reputation weights must sum to 1.0 in production, got ${wSum.toFixed(6)} ` +
        "from REP_WEIGHT_{FILL_RATE,LATENCY,SLASHES,QUOTE_HONOUR,VOLUME}.",
    });
  }
  return value;
});
