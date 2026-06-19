export type IntentState =
  | "open"
  | "accepted"
  | "filled"
  | "cancelled"
  | "expired"
  | "slashed";

export interface Intent {
  intentId: string;
  user: string;
  srcChain: SupportedChain;
  srcToken: TokenInfo;
  srcAmount: string;           // bigint as string
  dstToken: StellarToken;
  minDstAmount: string;
  quotedDstAmount?: string;    // best quote from solvers
  solver?: string;
  state: IntentState;
  createdAt: number;
  deadline: number;
  filledAt?: number;
  fillAmount?: string;
  txHash?: string;             // fill tx on Stellar
}

export interface SolverRecord {
  address: string;
  name: string;
  bondAmount: string;
  fillsCompleted: number;
  fillsFailed: number;
  totalVolume: string;
  avgFillTime: number;         // seconds
  isActive: boolean;
  registeredAt: number;
  supportedChains: SupportedChain[];
  supportedTokens: string[];
}

export interface Quote {
  intentId: string;
  solver: string;
  dstAmount: string;
  fee: string;                 // protocol fee in dst token
  fillTime: number;            // estimated seconds
  expiresAt: number;
}

export interface RouteStep {
  type: "bridge" | "swap" | "transfer";
  protocol: string;
  fromChain: string;
  toChain: string;
  fromToken: TokenInfo;
  toToken: TokenInfo;
  estimatedTime: number;
  estimatedGas: string;
}

export interface Route {
  steps: RouteStep[];
  totalTime: number;           // seconds
  totalFeesUSD: number;
  priceImpact: number;
}

export type SupportedChain =
  | "stellar"
  | "ethereum"
  | "base"
  | "polygon"
  | "arbitrum"
  | "optimism"
  | "avalanche";

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoURI?: string;
  priceUSD?: number;
}

export interface StellarToken {
  contract: string;
  symbol: string;
  decimals: number;
  priceUSD?: number;
}

export interface ProtocolStats {
  totalIntents: number;
  openIntents: number;
  totalVolume: string;
  uniqueUsers: number;
  activeSolvers: number;
  avgFillTime: number;
  fillRate: number;            // 0-1
}
