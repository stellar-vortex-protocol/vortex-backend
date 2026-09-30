import { Chain, keccak256, parseAbiItem, toBytes } from "viem";
import { arbitrum, avalanche, base, mainnet, optimism, polygon } from "viem/chains";
import { SupportedChain } from "../../intents/intents.types";

/** Source chains verified through EvmDepositVerifier (issue #403). */
export const EVM_SOURCE_CHAINS = ["ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"] as const;
export type EvmSourceChain = (typeof EVM_SOURCE_CHAINS)[number];

export function isEvmSourceChain(chain: SupportedChain | string): chain is EvmSourceChain {
  return (EVM_SOURCE_CHAINS as readonly string[]).includes(chain);
}

/**
 * When a deposit counts as final enough to expose the intent to solvers.
 *
 * - `depth`: the log's block must be at least `blocks` deep (head included).
 * - `safe`: the log's block must be at or below the chain's `safe` head. On
 *   the OP-stack L2s and Arbitrum that is the newest L2 block whose batch is
 *   posted to L1, so it survives sequencer reorgs.
 */
export type ConfirmationPolicy = { kind: "depth"; blocks: number } | { kind: "safe" };

export const CONFIRMATION_POLICIES: Record<EvmSourceChain, ConfirmationPolicy> = {
  ethereum: { kind: "depth", blocks: 12 },
  polygon: { kind: "depth", blocks: 128 }, // PoS reorgs of dozens of blocks have occurred
  base: { kind: "safe" },
  optimism: { kind: "safe" },
  arbitrum: { kind: "safe" },
  avalanche: { kind: "depth", blocks: 1 }, // Snowman consensus: accepted blocks are final
};

/** viem chain definitions, used for client defaults (block time, multicall, …). */
export const VIEM_CHAINS: Record<EvmSourceChain, Chain> = {
  ethereum: mainnet,
  base,
  polygon,
  arbitrum,
  optimism,
  avalanche,
};

/**
 * The escrow event the verifier matches. The escrow contract is out of scope
 * for this repo; this signature is the interface it must emit. `user` is the
 * intent's `user` field (the Stellar recipient), so the deposit is bound to
 * the intent's owner as well as its ID.
 */
export const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(bytes32 indexed intentId, address indexed token, address indexed depositor, uint256 amount, string user)",
);

/** Intent IDs are UUID strings; the escrow indexes keccak256(utf8(intentId)). */
export function intentIdToBytes32(intentId: string): `0x${string}` {
  return keccak256(toBytes(intentId));
}
