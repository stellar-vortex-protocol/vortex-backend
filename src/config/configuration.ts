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

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  stellar: {
    network: "testnet" | "futurenet" | "mainnet";
    sorobanRpcUrl: string;
    settlementContractId: string;
    solverRegistryContractId: string;
    // Secret key for the backend's Soroban signer. Empty outside production
    // (no on-chain write path exists yet); envValidationSchema requires and
    // format-checks it in production so it can never silently fall back to
    // a placeholder. Never log this value.
    signingKey: string;
    /** Fee percentile to use when estimating Soroban inclusion fees. */
    feePercentile: FeePercentile;
  };
  onchainIntentsEnabled: boolean;
  corsOrigin: string;
  /** Maximum concurrent WebSocket connections (0 = unlimited). */
  wsMaxConnections: number;
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
    settlementContractId: process.env.SETTLEMENT_CONTRACT_ID ?? "",
    solverRegistryContractId: process.env.SOLVER_REGISTRY_CONTRACT_ID ?? "",
    signingKey: process.env.SOROBAN_SIGNING_KEY ?? "",
    feePercentile: (process.env.SOROBAN_FEE_PERCENTILE ?? "p50") as FeePercentile,
  },
  onchainIntentsEnabled: (process.env.ONCHAIN_INTENTS_ENABLED ?? "false") === "true",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  wsMaxConnections: parseInt(process.env.WS_MAX_CONNECTIONS ?? "1000", 10),
});
