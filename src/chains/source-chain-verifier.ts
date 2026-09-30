import { Intent, SrcVerificationStatus, SupportedChain } from "../intents/intents.types";

/**
 * Result of checking an intent's source-chain deposit (issue #403).
 * `verified` is the only status that makes an intent fillable.
 */
export interface DepositCheck {
  status: Exclude<SrcVerificationStatus, "skipped" | "grandfathered">;
  blockNumber?: bigint;
  blockHash?: string;
  /** Amount the escrow received, in token base units. */
  receivedAmount?: string;
  detail?: string;
}

/**
 * Verifies that the user's funds are locked on the intent's source chain.
 * One adapter per chain family (EVM today); SourceDepositVerificationService
 * picks the first adapter whose `supports()` accepts the intent's chain.
 * Implementations throw on transport errors (so the caller can retry with
 * backoff) and return a DepositCheck for every definitive answer.
 */
export interface SourceChainVerifier {
  supports(chain: SupportedChain): boolean;
  verify(intent: Intent): Promise<DepositCheck>;
}

/** DI token for the list of registered SourceChainVerifier adapters. */
export const SOURCE_CHAIN_VERIFIERS = Symbol("SOURCE_CHAIN_VERIFIERS");
