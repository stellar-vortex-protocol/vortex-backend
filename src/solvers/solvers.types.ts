import { SupportedChain } from "../intents/intents.types";

export interface SolverRecord {
  address: string;
  name: string;
  bondAmount: string;
  fillsCompleted: number;
  fillsFailed: number;
  totalVolume: string;
  avgFillTime: number; // seconds
  isActive: boolean;
  registeredAt: number;
  supportedChains: SupportedChain[];
  supportedTokens: string[];
}
