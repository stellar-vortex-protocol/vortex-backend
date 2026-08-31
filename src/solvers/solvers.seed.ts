import { Keypair } from "@stellar/stellar-sdk";
import { SolverRecord } from "./solvers.types";

/**
 * Well-known test keypairs for seeded solvers.
 * Secret keys are only used in tests / the solver-bot demo.
 * In production solvers register via POST /api/v1/solvers/register.
 */
export const SEED_SOLVER_SECRETS = {
  ALPHA: "SCWJJ7RJRPSCSLIJ2FUPEE5MSKKL7TIBK65EXB7NDFC5MGBN6IPOU7PF",
  BETA:  "SBWYIL4TL74OJO3AY2C7C6HACHBDQUURZAY5H2URSARNNJ2OHKO6BQ7A",
  GAMMA: "SABOQPQHOWLQD27MQ5EHT2B2HCEFOUN2QONXBUZWWKPOMVQYBZVRASCM",
} as const;

/** Keypairs derived from the secrets above. Used by tests and the solver-bot demo. */
export const SEED_SOLVER_KEYPAIRS = {
  ALPHA: Keypair.fromSecret(SEED_SOLVER_SECRETS.ALPHA),
  BETA:  Keypair.fromSecret(SEED_SOLVER_SECRETS.BETA),
  GAMMA: Keypair.fromSecret(SEED_SOLVER_SECRETS.GAMMA),
};

export function buildSeedSolvers(): SolverRecord[] {
  const now = Math.floor(Date.now() / 1000);

  return [
    {
      address: SEED_SOLVER_KEYPAIRS.ALPHA.publicKey(),
      name: "Alpha Market Making",
      bondAmount: "50000000000", // 5000 USDC
      fillsCompleted: 842,
      fillsFailed: 3,
      totalVolume: "4200000000000",
      avgFillTime: 47,
      isActive: true,
      registeredAt: now - 86400 * 30,
      lastActiveAt: now - 3600,
      supportedChains: ["ethereum", "base", "arbitrum", "optimism"],
      supportedTokens: ["USDC", "WETH", "WBTC"],
    },
    {
      address: SEED_SOLVER_KEYPAIRS.BETA.publicKey(),
      name: "Beta Liquidity Co",
      bondAmount: "100000000000", // 10000 USDC
      fillsCompleted: 1241,
      fillsFailed: 8,
      totalVolume: "9800000000000",
      avgFillTime: 32,
      isActive: true,
      registeredAt: now - 86400 * 45,
      lastActiveAt: now - 1800,
      supportedChains: ["ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"],
      supportedTokens: ["USDC", "WETH", "WBTC", "MATIC", "AVAX"],
    },
    {
      address: SEED_SOLVER_KEYPAIRS.GAMMA.publicKey(),
      name: "Gamma Arb Labs",
      bondAmount: "25000000000", // 2500 USDC
      fillsCompleted: 187,
      fillsFailed: 12,
      totalVolume: "820000000000",
      avgFillTime: 89,
      isActive: true,
      registeredAt: now - 86400 * 7,
      lastActiveAt: now - 7200,
      supportedChains: ["ethereum", "polygon"],
      supportedTokens: ["USDC", "WETH"],
    },
  ];
}
