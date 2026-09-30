import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createPublicClient,
  http,
  isAddressEqual,
  parseEventLogs,
  PublicClient,
  TransactionReceiptNotFoundError,
} from "viem";
import { AppConfig } from "../../config/configuration";
import { Intent, SupportedChain } from "../../intents/intents.types";
import { DepositCheck, SourceChainVerifier } from "../source-chain-verifier";
import {
  CONFIRMATION_POLICIES,
  DEPOSITED_EVENT,
  EvmSourceChain,
  intentIdToBytes32,
  isEvmSourceChain,
  VIEM_CHAINS,
} from "./evm-chains";

/** Builds the viem client for a chain; overridable so tests can point at Anvil. */
export type EvmClientFactory = (chain: EvmSourceChain, rpcUrl: string) => PublicClient;
export const EVM_CLIENT_FACTORY = Symbol("EVM_CLIENT_FACTORY");

const defaultClientFactory: EvmClientFactory = (chain, rpcUrl) =>
  createPublicClient({
    chain: VIEM_CHAINS[chain],
    // viem retries transient failures (incl. 429) with backoff before throwing.
    transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
  }) as PublicClient;

type DepositedLog = {
  args: { intentId: `0x${string}`; token: `0x${string}`; depositor: `0x${string}`; amount: bigint; user: string };
  blockNumber: bigint | null;
  blockHash: `0x${string}` | null;
  removed?: boolean;
};

/**
 * Confirms an intent's escrow deposit on its EVM source chain (issue #403).
 *
 * Finds the escrow's `Deposited` log for the intent, either from the
 * receipt of `srcTxHash` when the client supplied one, or by searching the
 * last EVM_LOG_LOOKBACK_BLOCKS blocks by the indexed intent ID. It then checks
 * that the log's token, user and amount match the intent, and that the block
 * meets the chain's confirmation policy.
 *
 * A deposit that was seen before but has since disappeared (or whose block
 * fell below the confirmation depth) is reported as `reorged` or `pending`,
 * which un-verifies the intent. RPC/transport errors are thrown for the
 * caller to retry.
 */
@Injectable()
export class EvmDepositVerifier implements SourceChainVerifier {
  private readonly clients = new Map<EvmSourceChain, PublicClient>();

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    @Optional() @Inject(EVM_CLIENT_FACTORY) private readonly clientFactory: EvmClientFactory = defaultClientFactory,
  ) {}

  supports(chain: SupportedChain): boolean {
    return isEvmSourceChain(chain);
  }

  async verify(intent: Intent): Promise<DepositCheck> {
    const chain = intent.srcChain;
    if (!isEvmSourceChain(chain)) {
      return { status: "mismatch", detail: `${chain} is not an EVM source chain` };
    }
    const evm = this.configService.get("evm", { infer: true });
    const escrow = evm.escrowAddresses[chain] as `0x${string}` | undefined;
    const client = this.client(chain);
    if (!escrow || !client) {
      return { status: "pending", detail: `no RPC URL or escrow address configured for ${chain}` };
    }

    const logs = intent.srcTxHash
      ? await this.logsFromReceipt(client, escrow, intent)
      : await this.logsFromRange(client, escrow, intent, evm.logLookbackBlocks);
    if (typeof logs === "string") return { status: "mismatch", detail: logs };

    const log = logs.find((l) => !l.removed && l.blockNumber !== null && l.blockHash !== null);
    if (!log) return this.missing(intent);

    const blockNumber = log.blockNumber!;
    const blockHash = log.blockHash!;
    const located = { blockNumber, blockHash };

    if (!sameAddress(log.args.token, intent.srcToken.address)) {
      return { ...located, status: "mismatch", detail: `deposited token ${log.args.token} ≠ ${intent.srcToken.address}` };
    }
    if (log.args.user.toLowerCase() !== intent.user.toLowerCase()) {
      return { ...located, status: "mismatch", detail: `deposit is for user ${log.args.user}, not ${intent.user}` };
    }

    const received = log.args.amount;
    const receivedAmount = received.toString();
    const required = minimumReceived(BigInt(intent.srcAmount), evm.transferFeeToleranceBps);
    if (received < required) {
      return {
        ...located,
        receivedAmount,
        status: "mismatch",
        detail: `escrow received ${receivedAmount} < required ${required} (srcAmount ${intent.srcAmount})`,
      };
    }

    const confirmation = await this.confirmation(client, chain, blockNumber);
    return confirmation.ok
      ? { ...located, receivedAmount, status: "verified", detail: confirmation.detail }
      : { ...located, receivedAmount, status: "pending", detail: confirmation.detail };
  }

  private client(chain: EvmSourceChain): PublicClient | undefined {
    const cached = this.clients.get(chain);
    if (cached) return cached;
    const url = this.configService.get("evm", { infer: true }).rpcUrls[chain];
    if (!url) return undefined;
    const client = this.clientFactory(chain, url);
    this.clients.set(chain, client);
    return client;
  }

  /** Logs from the client-supplied deposit transaction; a string is a mismatch reason. */
  private async logsFromReceipt(
    client: PublicClient,
    escrow: `0x${string}`,
    intent: Intent,
  ): Promise<DepositedLog[] | string> {
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: intent.srcTxHash as `0x${string}` });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return [];
      throw err;
    }
    if (receipt.status !== "success") return `deposit transaction ${intent.srcTxHash} reverted`;

    const topic = intentIdToBytes32(intent.intentId);
    return (
      parseEventLogs({
        abi: [DEPOSITED_EVENT],
        eventName: "Deposited",
        logs: receipt.logs.filter((l) => sameAddress(l.address, escrow)),
      }) as unknown as DepositedLog[]
    ).filter((l) => l.args.intentId === topic);
  }

  private async logsFromRange(
    client: PublicClient,
    escrow: `0x${string}`,
    intent: Intent,
    lookback: number,
  ): Promise<DepositedLog[]> {
    const head = await client.getBlockNumber();
    const fromBlock = head > BigInt(lookback) ? head - BigInt(lookback) : 0n;
    return (await client.getLogs({
      address: escrow,
      event: DEPOSITED_EVENT,
      args: { intentId: intentIdToBytes32(intent.intentId) },
      fromBlock,
      toBlock: head,
    })) as unknown as DepositedLog[];
  }

  /** No matching log: a previously located deposit has been reorged out. */
  private missing(intent: Intent): DepositCheck {
    const seenBefore = intent.srcVerification?.blockHash !== undefined;
    return seenBefore
      ? { status: "reorged", detail: `deposit previously seen in block ${intent.srcVerification?.blockHash} is no longer canonical` }
      : { status: "not_found", detail: "no matching Deposited log yet" };
  }

  private async confirmation(
    client: PublicClient,
    chain: EvmSourceChain,
    blockNumber: bigint,
  ): Promise<{ ok: boolean; detail: string }> {
    const policy = CONFIRMATION_POLICIES[chain];
    if (policy.kind === "safe") {
      const safe = await client.getBlock({ blockTag: "safe" });
      return {
        ok: safe.number !== null && safe.number >= blockNumber,
        detail: `block ${blockNumber} vs safe head ${safe.number}`,
      };
    }
    const head = await client.getBlockNumber();
    const confirmations = head >= blockNumber ? head - blockNumber + 1n : 0n;
    return {
      ok: confirmations >= BigInt(policy.blocks),
      detail: `${confirmations}/${policy.blocks} confirmations`,
    };
  }
}

/** srcAmount reduced by the fee-on-transfer tolerance (basis points), rounded up. */
export function minimumReceived(srcAmount: bigint, toleranceBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(toleranceBps))));
  return (srcAmount * (10_000n - bps) + 9_999n) / 10_000n;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return isAddressEqual(a as `0x${string}`, b as `0x${string}`);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}
