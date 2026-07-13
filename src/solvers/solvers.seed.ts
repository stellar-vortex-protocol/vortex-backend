import { SolverRecord } from "./solvers.types";

export function buildSeedSolvers(): SolverRecord[] {
  const now = Math.floor(Date.now() / 1000);

  return [
    {
      address: "SOLVER_ALPHA",
      name: "Alpha Market Making",
      bondAmount: "50000000000", // 5000 USDC
      fillsCompleted: 842,
      fillsFailed: 3,
      totalVolume: "4200000000000",
      avgFillTime: 47,
      isActive: true,
      registeredAt: now - 86400 * 30,
      supportedChains: ["ethereum", "base", "arbitrum", "optimism"],
      supportedTokens: ["USDC", "WETH", "WBTC"],
    },
    {
      address: "SOLVER_BETA",
      name: "Beta Liquidity Co",
      bondAmount: "100000000000", // 10000 USDC
      fillsCompleted: 1241,
      fillsFailed: 8,
      totalVolume: "9800000000000",
      avgFillTime: 32,
      isActive: true,
      registeredAt: now - 86400 * 45,
      supportedChains: ["ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"],
      supportedTokens: ["USDC", "WETH", "WBTC", "MATIC", "AVAX"],
    },
    {
      address: "SOLVER_GAMMA",
      name: "Gamma Arb Labs",
      bondAmount: "25000000000", // 2500 USDC
      fillsCompleted: 187,
      fillsFailed: 12,
      totalVolume: "820000000000",
      avgFillTime: 89,
      isActive: true,
      registeredAt: now - 86400 * 7,
      supportedChains: ["ethereum", "polygon"],
      supportedTokens: ["USDC", "WETH"],
    },
  ];
}
