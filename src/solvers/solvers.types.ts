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
  /** Unix epoch seconds of the solver's most recent activity (registration, fill, or status change). */
  lastActiveAt: number;
  supportedChains: SupportedChain[];
  supportedTokens: string[];
}
