/**
 * Central resource-limit constants for REST and WebSocket inputs (issue #476).
 *
 * Every limit that guards server resources — array sizes, filter counts,
 * JSON depth, WS subscription counts — is defined here so DTO decorators and
 * the gateway share a single source of truth.  Env-override variants live in
 * src/config/configuration.ts; these constants are the compile-time defaults
 * that are used when no env override is present.
 *
 * SDK-friendliness note:
 *   Limits are intentionally generous relative to typical single-user UI
 *   flows (1–3 active intents at a time, 1–2 chain filters).  The upper
 *   bounds are set to block pathological amplification (100-item batches that
 *   fan out to 100 DB reads, 50-chain filter sets that never match anything)
 *   while leaving substantial headroom for legitimate solver bots.
 */

// ── REST body & JSON ─────────────────────────────────────────────────────────

/** Maximum HTTP request body size accepted by express.json().  "10kb" string
 *  format is what express body-parser expects.  The corresponding numeric
 *  constant is used for documentation / assertion only. */
export const BODY_SIZE_LIMIT = "10kb";

/**
 * Maximum JSON object nesting depth enforced before class-validator runs.
 *
 * A deeply nested object (e.g. 1 000 levels) can exhaust the call stack in
 * both the JSON parser and recursive validator traversal before any field
 * decorator fires.  We reject at depth 10 — all real DTOs use flat or
 * two-level structures.
 *
 * Rationale for 10: the deepest current DTO is two levels deep (nested token
 * objects inside CreateIntentDto → 3 levels of JSON). 10 gives a ×3 safety
 * margin while reliably blocking stack-exhaustion attempts.
 */
export const JSON_MAX_DEPTH = 10;

// ── Batch / array size ───────────────────────────────────────────────────────

/**
 * Maximum number of intent IDs in a single `POST /api/v1/intents/batch`
 * request.  Each ID fans out to one DB read, so 100 items at ~1 ms each is
 * a ~100 ms DB round-trip budget — acceptable for a solver reconciliation
 * call, but large enough to warrant an explicit cap.
 */
export const BATCH_LOOKUP_MAX_IDS = 100;

// ── Pagination ───────────────────────────────────────────────────────────────

/**
 * Maximum `limit` value for list endpoints (GET /api/v1/intents etc.).
 * One page of 100 rows is already a generous snapshot; larger values risk
 * transferring tens of KB of JSON per request.
 */
export const LIST_MAX_LIMIT = 100;

// ── WebSocket per-connection limits ─────────────────────────────────────────

/**
 * Maximum number of active topic subscriptions a single WebSocket client may
 * hold simultaneously.
 *
 * Current protocol only exposes one subscription type (chain filter), so
 * this is effectively "1 active subscribe message at a time."  The constant
 * is defined for forward-compatibility when additional subscription types
 * (e.g. solver-specific feeds) are added.
 */
export const WS_MAX_SUBSCRIPTIONS_PER_CONNECTION = 10;

/**
 * Maximum number of chain values a client may include in a single
 * `{ type: "subscribe", chains: [...] }` message.
 *
 * There are 7 supported chains (SUPPORTED_CHAINS); a cap of 20 is twice that
 * — enough for any realistic multi-chain solver bot while preventing a client
 * from sending thousands of chain values to force linear scan work.
 */
export const WS_MAX_FILTER_CHAINS = 20;

// ── Database timeouts ────────────────────────────────────────────────────────

/**
 * Default Postgres `statement_timeout` in milliseconds applied via
 * `SET LOCAL statement_timeout` before each query class.
 *
 * 5 000 ms (5 s) is generous for any indexed lookup; it guards against
 * accidental full-table scans triggered by missing indexes after a migration.
 * Route classes that perform heavier work (batch, list with large offsets)
 * use their own higher ceiling defined below.
 */
export const DB_QUERY_TIMEOUT_MS = 5_000;

/**
 * Timeout for batch-lookup queries that fan out across multiple intent rows.
 * Slightly higher than the default to account for N individual reads.
 */
export const DB_BATCH_QUERY_TIMEOUT_MS = 10_000;

/**
 * Timeout for solver leaderboard / aggregate stats queries which may scan
 * larger index ranges than simple intent lookups.
 */
export const DB_STATS_QUERY_TIMEOUT_MS = 15_000;
