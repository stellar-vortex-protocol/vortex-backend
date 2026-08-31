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
 * Default fill-window in seconds per source chain.
 * Chains with slower finality get a longer window.
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

/** Fallback when chain is not in the map. */
export const DEFAULT_DEADLINE_SECONDS = 1800;

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
  intentRetentionDays: number;
  intentRetentionSweepMs: number;
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
  intentRetentionDays: parseInt(process.env.INTENT_RETENTION_DAYS ?? "30", 10),
  intentRetentionSweepMs: parseInt(process.env.INTENT_RETENTION_SWEEP_MS ?? "60000", 10),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  wsMaxConnections: parseInt(process.env.WS_MAX_CONNECTIONS ?? "1000", 10),
});
