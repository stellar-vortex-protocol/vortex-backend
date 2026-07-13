export interface AppConfig {
  nodeEnv: string;
  port: number;
  stellar: {
    network: "testnet" | "futurenet" | "mainnet";
    sorobanRpcUrl: string;
    settlementContractId: string;
    solverRegistryContractId: string;
  };
  corsOrigin: string;
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  stellar: {
    network: (process.env.STELLAR_NETWORK ?? "testnet") as AppConfig["stellar"]["network"],
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    settlementContractId: process.env.SETTLEMENT_CONTRACT_ID ?? "",
    solverRegistryContractId: process.env.SOLVER_REGISTRY_CONTRACT_ID ?? "",
  },
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
});
