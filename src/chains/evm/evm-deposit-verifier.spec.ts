import { ConfigService } from "@nestjs/config";
import {
  encodeAbiParameters,
  encodeEventTopics,
  PublicClient,
  TransactionReceiptNotFoundError,
} from "viem";
import { AppConfig, EvmVerificationConfig } from "../../config/configuration";
import { Intent } from "../../intents/intents.types";
import { EvmDepositVerifier, minimumReceived } from "./evm-deposit-verifier";
import { DEPOSITED_EVENT, intentIdToBytes32, isEvmSourceChain } from "./evm-chains";

const ESCROW = "0x1111111111111111111111111111111111111111";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEPOSITOR = "0x2222222222222222222222222222222222222222";
const USER = "GUSERSTELLARADDRESS";
const TX = `0x${"cd".repeat(32)}` as const;
const BLOCK_HASH = `0x${"ee".repeat(32)}` as const;

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "8f1c7a8e-4d7b-4c55-9d0a-0c2b8a1e2f3d",
    user: USER,
    srcChain: "ethereum",
    srcToken: { address: TOKEN, symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: 1,
    deadline: 2,
    version: 0,
    srcVerified: false,
    ...overrides,
  };
}

/** A real ABI-encoded Deposited log, as an RPC node would return it. */
function depositedLog(overrides: {
  intentId?: string;
  token?: `0x${string}`;
  amount?: bigint;
  user?: string;
  address?: `0x${string}`;
  blockNumber?: bigint;
  removed?: boolean;
} = {}) {
  const intentId = intentIdToBytes32(overrides.intentId ?? intent().intentId);
  const token = overrides.token ?? TOKEN;
  const amount = overrides.amount ?? 1_000_000n;
  const user = overrides.user ?? USER;
  return {
    address: overrides.address ?? ESCROW,
    topics: encodeEventTopics({ abi: [DEPOSITED_EVENT], eventName: "Deposited", args: { intentId, token, depositor: DEPOSITOR } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }], [amount, user]),
    blockNumber: overrides.blockNumber ?? 100n,
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    logIndex: 0,
    transactionIndex: 0,
    removed: overrides.removed ?? false,
    // Decoded form, matching what getLogs({ event }) returns.
    args: { intentId, token, depositor: DEPOSITOR, amount, user },
  };
}

function fakeClient(opts: { head?: bigint; safe?: bigint | null; logs?: unknown[]; receipt?: unknown } = {}) {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(opts.head ?? 111n),
    getBlock: jest.fn().mockResolvedValue({ number: opts.safe === undefined ? 200n : opts.safe }),
    getLogs: jest.fn().mockResolvedValue(opts.logs ?? [depositedLog()]),
    getTransactionReceipt: jest.fn().mockImplementation(async () => {
      if (opts.receipt instanceof Error) throw opts.receipt;
      return opts.receipt ?? { status: "success", logs: [depositedLog()] };
    }),
  };
}

function build(client: ReturnType<typeof fakeClient>, evm: Partial<EvmVerificationConfig> = {}) {
  const config: EvmVerificationConfig = {
    depositVerificationEnabled: true,
    rpcUrls: { ethereum: "http://eth", base: "http://base", polygon: "http://polygon" },
    escrowAddresses: { ethereum: ESCROW, base: ESCROW, polygon: ESCROW },
    transferFeeToleranceBps: 0,
    logLookbackBlocks: 10_000,
    ...evm,
  };
  const factory = jest.fn(() => client as unknown as PublicClient);
  const verifier = new EvmDepositVerifier(
    { get: () => config } as unknown as ConfigService<AppConfig, true>,
    factory,
  );
  return { verifier, factory };
}

describe("EvmDepositVerifier (issue #403)", () => {
  it("supports only EVM source chains", () => {
    const { verifier } = build(fakeClient());
    expect(verifier.supports("ethereum")).toBe(true);
    expect(verifier.supports("avalanche")).toBe(true);
    expect(verifier.supports("stellar")).toBe(false);
    expect(isEvmSourceChain("stellar")).toBe(false);
  });

  it("rejects a non-EVM intent", async () => {
    const { verifier } = build(fakeClient());
    expect(await verifier.verify(intent({ srcChain: "stellar" }))).toMatchObject({ status: "mismatch" });
  });

  it("stays pending when the chain has no RPC or escrow configured", async () => {
    const { verifier } = build(fakeClient());
    expect(await verifier.verify(intent({ srcChain: "arbitrum" }))).toMatchObject({
      status: "pending",
      detail: expect.stringMatching(/no RPC URL or escrow address configured for arbitrum/),
    });
  });

  describe("log search (no srcTxHash)", () => {
    it("verifies a matching deposit with enough confirmations (ethereum: 12)", async () => {
      const client = fakeClient({ head: 111n }); // block 100 → 12 confirmations
      const { verifier } = build(client);

      const check = await verifier.verify(intent());

      expect(check).toMatchObject({
        status: "verified",
        blockNumber: 100n,
        blockHash: BLOCK_HASH,
        receivedAmount: "1000000",
        detail: "12/12 confirmations",
      });
      expect(client.getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ address: ESCROW, args: { intentId: intentIdToBytes32(intent().intentId) }, fromBlock: 0n, toBlock: 111n }),
      );
    });

    it("bounds the search to EVM_LOG_LOOKBACK_BLOCKS", async () => {
      const client = fakeClient({ head: 50_000n, logs: [] });
      const { verifier } = build(client, { logLookbackBlocks: 1_000 });
      await verifier.verify(intent());
      expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 49_000n, toBlock: 50_000n }));
    });

    it("stays pending below the confirmation depth", async () => {
      const { verifier } = build(fakeClient({ head: 102n }));
      expect(await verifier.verify(intent())).toMatchObject({ status: "pending", detail: "3/12 confirmations" });
    });

    it("uses the deeper polygon depth (128)", async () => {
      const { verifier } = build(fakeClient({ head: 200n }));
      expect(await verifier.verify(intent({ srcChain: "polygon" }))).toMatchObject({
        status: "pending",
        detail: "101/128 confirmations",
      });
    });

    it("uses the safe head on L2s", async () => {
      const behind = build(fakeClient({ safe: 99n }));
      expect(await behind.verifier.verify(intent({ srcChain: "base" }))).toMatchObject({ status: "pending" });

      const caughtUp = build(fakeClient({ safe: 100n }));
      expect(await caughtUp.verifier.verify(intent({ srcChain: "base" }))).toMatchObject({ status: "verified" });

      const noSafe = build(fakeClient({ safe: null }));
      expect(await noSafe.verifier.verify(intent({ srcChain: "base" }))).toMatchObject({ status: "pending" });
    });

    it("reports not_found when no deposit exists yet", async () => {
      const { verifier } = build(fakeClient({ logs: [] }));
      expect(await verifier.verify(intent())).toMatchObject({ status: "not_found" });
    });

    it("reports reorged when a previously located deposit disappears", async () => {
      const { verifier } = build(fakeClient({ logs: [depositedLog({ removed: true })] }));
      const seen = intent({
        srcVerified: true,
        srcVerification: { status: "verified", checkedAt: 1, blockHash: BLOCK_HASH, blockNumber: "100" },
      });
      expect(await verifier.verify(seen)).toMatchObject({ status: "reorged" });
    });

    it("rejects a deposit of the wrong token", async () => {
      const { verifier } = build(fakeClient({ logs: [depositedLog({ token: DEPOSITOR })] }));
      expect(await verifier.verify(intent())).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/token/) });
    });

    it("rejects a deposit made for another user", async () => {
      const { verifier } = build(fakeClient({ logs: [depositedLog({ user: "GSOMEONEELSE" })] }));
      expect(await verifier.verify(intent())).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/user/) });
    });

    it("matches the user case-insensitively", async () => {
      const { verifier } = build(fakeClient({ logs: [depositedLog({ user: USER.toLowerCase() })] }));
      expect(await verifier.verify(intent())).toMatchObject({ status: "verified" });
    });

    it("rejects a short deposit and records what the escrow received", async () => {
      const { verifier } = build(fakeClient({ logs: [depositedLog({ amount: 999_000n })] }));
      expect(await verifier.verify(intent())).toMatchObject({ status: "mismatch", receivedAmount: "999000" });
    });

    it("accepts fee-on-transfer shortfalls within EVM_TRANSFER_FEE_TOLERANCE_BPS", async () => {
      const { verifier } = build(fakeClient({ logs: [depositedLog({ amount: 999_000n })] }), { transferFeeToleranceBps: 10 });
      expect(await verifier.verify(intent())).toMatchObject({ status: "verified", receivedAmount: "999000" });
    });

    it("propagates RPC errors so the caller can retry", async () => {
      const client = fakeClient();
      client.getLogs.mockRejectedValue(new Error("429 Too Many Requests"));
      const { verifier } = build(client);
      await expect(verifier.verify(intent())).rejects.toThrow(/429/);
    });

    it("creates one client per chain", async () => {
      const { verifier, factory } = build(fakeClient());
      await verifier.verify(intent());
      await verifier.verify(intent());
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith("ethereum", "http://eth");
    });
  });

  describe("receipt lookup (srcTxHash supplied)", () => {
    const withTx = intent({ srcTxHash: TX });

    it("verifies from the receipt without scanning blocks", async () => {
      const client = fakeClient();
      const { verifier } = build(client);
      expect(await verifier.verify(withTx)).toMatchObject({ status: "verified", receivedAmount: "1000000" });
      expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
      expect(client.getLogs).not.toHaveBeenCalled();
    });

    it("ignores Deposited logs from other contracts or for other intents", async () => {
      const receipt = {
        status: "success",
        logs: [depositedLog({ address: DEPOSITOR }), depositedLog({ intentId: "another-intent" })],
      };
      const { verifier } = build(fakeClient({ receipt }));
      expect(await verifier.verify(withTx)).toMatchObject({ status: "not_found" });
    });

    it("reports not_found while the transaction is unknown", async () => {
      const { verifier } = build(fakeClient({ receipt: new TransactionReceiptNotFoundError({ hash: TX }) }));
      expect(await verifier.verify(withTx)).toMatchObject({ status: "not_found" });
    });

    it("reports a reverted deposit as a mismatch", async () => {
      const { verifier } = build(fakeClient({ receipt: { status: "reverted", logs: [] } }));
      expect(await verifier.verify(withTx)).toMatchObject({ status: "mismatch", detail: expect.stringMatching(/reverted/) });
    });

    it("propagates other receipt errors", async () => {
      const { verifier } = build(fakeClient({ receipt: new Error("connection reset") }));
      await expect(verifier.verify(withTx)).rejects.toThrow("connection reset");
    });
  });
});

describe("minimumReceived", () => {
  it("applies the tolerance in basis points, rounding up", () => {
    expect(minimumReceived(1_000_000n, 0)).toBe(1_000_000n);
    expect(minimumReceived(1_000_000n, 10)).toBe(999_000n);
    expect(minimumReceived(3n, 5000)).toBe(2n); // 1.5 → 2
  });

  it("clamps out-of-range tolerances", () => {
    expect(minimumReceived(100n, -5)).toBe(100n);
    expect(minimumReceived(100n, 20_000)).toBe(0n);
  });
});
