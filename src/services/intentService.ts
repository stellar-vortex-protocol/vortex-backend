import { v4 as uuidv4 } from "uuid";
import type { Intent, IntentState, SolverRecord } from "../types";

// ─── Intent Store ─────────────────────────────────────────────────────────────

class IntentStore {
  private intents = new Map<string, Intent>();

  constructor() {
    this.seed();
  }

  create(data: Omit<Intent, "intentId" | "createdAt" | "state">): Intent {
    const now = Math.floor(Date.now() / 1000);
    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: data.deadline ?? now + 1800,
    };
    this.intents.set(intent.intentId, intent);
    return intent;
  }

  get(id: string): Intent | undefined {
    return this.intents.get(id);
  }

  getAll(): Intent[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getByState(state: IntentState): Intent[] {
    return this.getAll().filter(i => i.state === state);
  }

  getByUser(user: string): Intent[] {
    return this.getAll().filter(i => i.user.toLowerCase() === user.toLowerCase());
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.intents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.intents.set(id, updated);
    return updated;
  }

  private seed() {
    const now = Math.floor(Date.now() / 1000);

    const seedData: Omit<Intent, "intentId" | "createdAt">[] = [
      {
        user: "GABC...1234",
        srcChain: "ethereum",
        srcToken: {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          chain: "ethereum",
          priceUSD: 1.0,
        },
        srcAmount: "500000000",        // 500 USDC
        dstToken: {
          contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          symbol: "USDC",
          decimals: 7,
        },
        minDstAmount: "4950000000",    // 495 USDC (1% slippage)
        state: "open",
        deadline: now + 1200,
      },
      {
        user: "GDEF...5678",
        srcChain: "base",
        srcToken: {
          address: "0x4200000000000000000000000000000000000006",
          symbol: "WETH",
          name: "Wrapped Ether",
          decimals: 18,
          chain: "base",
          priceUSD: 3512.80,
        },
        srcAmount: "140000000000000000", // 0.14 ETH
        dstToken: {
          contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          symbol: "USDC",
          decimals: 7,
        },
        minDstAmount: "4800000000",     // $480 USDC (accepting ~2% slippage)
        state: "open",
        deadline: now + 900,
      },
      {
        user: "GHIJ...9012",
        srcChain: "polygon",
        srcToken: {
          address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          chain: "polygon",
          priceUSD: 1.0,
        },
        srcAmount: "100000000",        // 100 USDC
        dstToken: {
          contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          symbol: "XLM",
          decimals: 7,
        },
        minDstAmount: "8200000000",    // ~820 XLM
        state: "accepted",
        solver: "SOLVER_ALPHA",
        deadline: now + 240,
      },
      {
        user: "GKLM...3456",
        srcChain: "arbitrum",
        srcToken: {
          address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
          symbol: "WETH",
          name: "Wrapped Ether",
          decimals: 18,
          chain: "arbitrum",
          priceUSD: 3512.80,
        },
        srcAmount: "1000000000000000000", // 1 ETH
        dstToken: {
          contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          symbol: "USDC",
          decimals: 7,
        },
        minDstAmount: "34500000000",   // 3450 USDC
        state: "filled",
        solver: "SOLVER_BETA",
        deadline: now - 300,
        filledAt: now - 120,
        fillAmount: "35100000000",
        txHash: "abc123def456",
      },
      {
        user: "GNOP...7890",
        srcChain: "optimism",
        srcToken: {
          address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          chain: "optimism",
          priceUSD: 1.0,
        },
        srcAmount: "200000000",       // 200 USDC
        dstToken: {
          contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          symbol: "USDC",
          decimals: 7,
        },
        minDstAmount: "1980000000",
        state: "open",
        deadline: now + 1600,
      },
    ];

    for (const data of seedData) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.intents.set(intent.intentId, intent);
    }
  }
}

// ─── Solver Store ─────────────────────────────────────────────────────────────

class SolverStore {
  private solvers = new Map<string, SolverRecord>();

  constructor() {
    this.seed();
  }

  getAll(): SolverRecord[] {
    return [...this.solvers.values()];
  }

  get(address: string): SolverRecord | undefined {
    return this.solvers.get(address);
  }

  register(data: Omit<SolverRecord, "registeredAt" | "fillsCompleted" | "fillsFailed" | "totalVolume">): SolverRecord {
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: Math.floor(Date.now() / 1000),
    };
    this.solvers.set(solver.address, solver);
    return solver;
  }

  private seed() {
    const seedSolvers: SolverRecord[] = [
      {
        address: "SOLVER_ALPHA",
        name: "Alpha Market Making",
        bondAmount: "50000000000",  // 5000 USDC
        fillsCompleted: 842,
        fillsFailed: 3,
        totalVolume: "4200000000000",
        avgFillTime: 47,
        isActive: true,
        registeredAt: Math.floor(Date.now() / 1000) - 86400 * 30,
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
        registeredAt: Math.floor(Date.now() / 1000) - 86400 * 45,
        supportedChains: ["ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"],
        supportedTokens: ["USDC", "WETH", "WBTC", "MATIC", "AVAX"],
      },
      {
        address: "SOLVER_GAMMA",
        name: "Gamma Arb Labs",
        bondAmount: "25000000000",  // 2500 USDC
        fillsCompleted: 187,
        fillsFailed: 12,
        totalVolume: "820000000000",
        avgFillTime: 89,
        isActive: true,
        registeredAt: Math.floor(Date.now() / 1000) - 86400 * 7,
        supportedChains: ["ethereum", "polygon"],
        supportedTokens: ["USDC", "WETH"],
      },
    ];

    for (const s of seedSolvers) {
      this.solvers.set(s.address, s);
    }
  }
}

export const intentStore = new IntentStore();
export const solverStore = new SolverStore();
