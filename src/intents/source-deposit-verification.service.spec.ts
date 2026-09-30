import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { DepositCheck, SourceChainVerifier } from "../chains/source-chain-verifier";
import { MetricsService } from "../metrics/metrics.service";
import { InMemoryIntentsRepository } from "./intents.repository";
import { IntentsService, NewIntentData } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { PrismaService } from "../prisma/prisma.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { ProtocolParamsService } from "../governance/params.service";
import {
  isRateLimited,
  SourceDepositVerificationService,
  SRC_RATE_LIMIT_MULTIPLIER,
  SRC_RETRY_BASE_MS,
  SRC_REVERIFY_INTERVAL_MS,
} from "./source-deposit-verification.service";

const T0 = 1_900_000_000_000;

function config(enabled: boolean): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    evm: { depositVerificationEnabled: enabled, rpcUrls: {}, escrowAddresses: {}, transferFeeToleranceBps: 0, logLookbackBlocks: 1 },
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

const data = (srcChain: NewIntentData["srcChain"] = "ethereum"): NewIntentData => ({
  user: "GUSER",
  srcChain,
  srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: srcChain },
  srcAmount: "1000000",
  dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
  minDstAmount: "990000",
  deadline: Math.floor(Date.now() / 1000) + 3600,
});

function build(enabled = true) {
  const intents = new IntentsService(
    new InMemoryIntentsRepository({ seed: false }),
    config(enabled),
    {} as StellarTxService,
    { intentAuditLog: { create: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService,
    undefined, // shadow monitor
    undefined, // metrics
    { snapshotForChain: () => ({ version: 0, deadlineSeconds: 1800, fillWindowSeconds: 600 }) } as unknown as ProtocolParamsService,
  );
  const verify = jest.fn<Promise<DepositCheck>, [unknown]>();
  const verifier: SourceChainVerifier = { supports: (c) => c !== "stellar", verify: verify as SourceChainVerifier["verify"] };
  const gateway = { broadcast: jest.fn().mockResolvedValue(undefined) };
  const metrics = {
    recordSrcVerification: jest.fn(),
    recordSrcVerificationError: jest.fn(),
    setSrcVerificationQueueSize: jest.fn(),
  };
  const service = new SourceDepositVerificationService(
    intents,
    gateway as unknown as IntentsGateway,
    config(enabled),
    [verifier],
    metrics as unknown as MetricsService,
  );
  return { intents, service, verify, gateway, metrics };
}

const VERIFIED: DepositCheck = { status: "verified", blockNumber: 100n, blockHash: "0xblock", receivedAmount: "1000000", detail: "12/12 confirmations" };

describe("IntentsService — initial source verification (issue #403)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("starts EVM intents unverified when verification is enabled", async () => {
    const { intents } = build(true);
    const created = await intents.create(data("base"));
    expect(created).toMatchObject({ srcVerified: false, srcVerification: { status: "pending" } });
  });

  it("marks Stellar-source intents verified (non-EVM chains are out of scope)", async () => {
    const { intents } = build(true);
    expect(await intents.create(data("stellar"))).toMatchObject({
      srcVerified: true,
      srcVerification: { status: "skipped", detail: "non-EVM source chain" },
    });
  });

  it("marks every intent verified while the feature is disabled", async () => {
    const { intents } = build(false);
    expect(await intents.create(data("ethereum"))).toMatchObject({
      srcVerified: true,
      srcVerification: { status: "skipped", detail: "deposit verification disabled" },
    });
  });
});

describe("SourceDepositVerificationService (issue #403)", () => {
  let h: ReturnType<typeof build>;

  afterEach(() => {
    h.service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("does nothing while disabled", async () => {
    h = build(false);
    h.service.onModuleInit();
    await h.intents.create(data());
    expect(await h.service.tick(T0)).toBe(0);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("verifies a pending intent, persists the result with a version bump, and broadcasts it", async () => {
    h = build();
    const created = await h.intents.create(data());
    h.verify.mockResolvedValue(VERIFIED);

    expect(await h.service.tick(T0)).toBe(1);

    const stored = (await h.intents.get(created.intentId))!;
    expect(stored).toMatchObject({
      srcVerified: true,
      version: created.version + 1,
      srcVerification: {
        status: "verified",
        checkedAt: Math.floor(T0 / 1000),
        blockNumber: "100",
        blockHash: "0xblock",
        receivedAmount: "1000000",
      },
    });
    expect(h.gateway.broadcast).toHaveBeenCalledWith({ type: "intent_src_verified", intentId: created.intentId, intent: stored });
    expect(h.metrics.recordSrcVerification).toHaveBeenCalledWith("ethereum", "verified");
  });

  it("keeps an unconfirmed deposit unverified and backs off before re-checking", async () => {
    h = build();
    const created = await h.intents.create(data());
    h.verify.mockResolvedValue({ status: "pending", detail: "3/12 confirmations" });

    await h.service.tick(T0);
    expect((await h.intents.get(created.intentId))!).toMatchObject({ srcVerified: false, srcVerification: { status: "pending", detail: "3/12 confirmations" } });

    expect(await h.service.tick(T0 + SRC_RETRY_BASE_MS - 1)).toBe(0);
    expect(await h.service.tick(T0 + SRC_RETRY_BASE_MS)).toBe(1);
    // Second failure doubles the wait.
    expect(await h.service.tick(T0 + SRC_RETRY_BASE_MS * 2)).toBe(0);
    expect(await h.service.tick(T0 + SRC_RETRY_BASE_MS * 3)).toBe(1);
    expect(h.gateway.broadcast).not.toHaveBeenCalled();
  });

  it("retries RPC errors with backoff, longer after a rate limit", async () => {
    h = build();
    await h.intents.create(data());
    h.verify.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 429 }));

    await h.service.tick(T0);
    expect(h.metrics.recordSrcVerificationError).toHaveBeenCalledWith("ethereum", "rate_limited");
    expect(await h.service.tick(T0 + SRC_RETRY_BASE_MS)).toBe(0);
    h.verify.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await h.service.tick(T0 + SRC_RETRY_BASE_MS * SRC_RATE_LIMIT_MULTIPLIER)).toBe(1);
    expect(h.metrics.recordSrcVerificationError).toHaveBeenCalledWith("ethereum", "rpc_error");
  });

  it("re-checks verified open intents and un-verifies them after a reorg", async () => {
    h = build();
    const created = await h.intents.create(data());
    h.verify.mockResolvedValueOnce(VERIFIED);
    await h.service.tick(T0);

    // Not yet due for its re-check.
    expect(await h.service.tick(T0 + SRC_REVERIFY_INTERVAL_MS - 1000)).toBe(0);

    h.verify.mockResolvedValueOnce({ status: "reorged", detail: "block 0xblock no longer canonical" });
    expect(await h.service.tick(T0 + SRC_REVERIFY_INTERVAL_MS)).toBe(1);

    expect((await h.intents.get(created.intentId))!).toMatchObject({ srcVerified: false, srcVerification: { status: "reorged" } });
    expect(h.gateway.broadcast).toHaveBeenLastCalledWith({
      type: "intent_src_unverified",
      intentId: created.intentId,
      srcChain: "ethereum",
      reason: "reorged",
    });
  });

  it("never re-verifies intents it did not verify (skipped / grandfathered)", async () => {
    h = build();
    await h.intents.create(data("stellar"));
    const grandfathered = await h.intents.create(data());
    await h.intents.update(
      grandfathered.intentId,
      { srcVerified: true, srcVerification: { status: "grandfathered", checkedAt: 0 } },
      grandfathered.version,
    );

    expect(await h.service.tick(T0)).toBe(0);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("does not write a result onto an intent that left the open state meanwhile", async () => {
    h = build();
    const created = await h.intents.create(data());
    h.verify.mockImplementation(async () => {
      await h.intents.cancelIfOpen(created.intentId); // user cancels mid-verification
      return VERIFIED;
    });

    await h.service.tick(T0);

    expect((await h.intents.get(created.intentId))!).toMatchObject({ state: "cancelled", srcVerified: false });
    expect(h.gateway.broadcast).not.toHaveBeenCalled();
  });

  it("skips a tick while the previous one is still running", async () => {
    h = build();
    await h.intents.create(data());
    let release!: () => void;
    h.verify.mockReturnValue(new Promise((r) => (release = () => r(VERIFIED))));

    const first = h.service.tick(T0);
    await new Promise((r) => setImmediate(r));
    expect(await h.service.tick(T0)).toBe(0);
    release();
    expect(await first).toBe(1);
  });

  it("runs tick() on its interval once enabled, and logs tick failures", async () => {
    jest.useFakeTimers();
    try {
      h = build();
      const tick = jest.spyOn(h.service, "tick").mockRejectedValueOnce(new Error("store down")).mockResolvedValue(0);
      h.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(15_000 * 2);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("returns undefined for intents no verifier handles", async () => {
    h = build();
    const stellar = await h.intents.create(data("stellar"));
    expect(await h.service.verifyOne(stellar, T0)).toBeUndefined();
  });
});

describe("isRateLimited", () => {
  it.each([
    [{ status: 429 }, true],
    [{ code: -32005 }, true],
    [new Error("Too Many Requests"), true],
    [Object.assign(new Error("HTTP request failed"), { cause: { status: 429 } }), true],
    [new Error("execution reverted"), false],
    [undefined, false],
  ])("%p → %p", (err, expected) => {
    expect(isRateLimited(err)).toBe(expected);
  });
});
