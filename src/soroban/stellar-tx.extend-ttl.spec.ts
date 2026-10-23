import { Account, Keypair, Networks, SorobanRpc, StrKey, Transaction } from "@stellar/stellar-sdk";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { KillSwitchActiveException } from "../killswitch/killswitch.guard";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";
import { StellarTxService, TtlExtensionOverBudgetError } from "./stellar-tx.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { contractInstanceKey } from "./ttl-keys";

/** Issue #395 — StellarTxService.extendFootprintTtl. */

const SIGNER = Keypair.random();
const KEYS = [1, 2, 3].map((n) => contractInstanceKey("settlement", StrKey.encodeContract(Buffer.alloc(32, n))).key);

function build(opts: { dryRun?: boolean; resourceFee?: string; preparedFee?: string; paused?: boolean } = {}) {
  const soroban = {
    getFeeStats: jest.fn().mockRejectedValue(new Error("no stats")), // → BASE_FEE (100)
    getAccount: jest.fn().mockResolvedValue(new Account(SIGNER.publicKey(), "41")),
    simulateTransaction: jest.fn().mockResolvedValue({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      minResourceFee: opts.resourceFee ?? "900",
      transactionData: {},
      cost: { cpuInsns: "0", memBytes: "0" },
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse),
    prepareTransaction: jest.fn(async (tx: Transaction) => ({ fee: opts.preparedFee ?? "1000", source: tx.source })),
    submitTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "abc123" }),
  };
  const signer = {
    getPublicKey: () => SIGNER.publicKey(),
    getNetworkPassphrase: () => Networks.TESTNET,
    withNextSequence: jest.fn(async (fn: (seq: string) => Promise<unknown>) => fn("42")),
    sign: jest.fn(async (tx: unknown) => tx),
  };
  const confirmation = {
    waitForConfirmation: jest.fn().mockResolvedValue({ status: "SUCCESS", durationMs: 1 }),
  };
  const config = {
    get: (path: string) =>
      ({ onchainDryRun: opts.dryRun ?? false, "stellar.feePercentile": "p50", "stellar.network": "testnet" })[path],
  } as unknown as ConfigService<AppConfig, true>;
  const killSwitch = {
    evaluateTarget: jest.fn().mockReturnValue(
      opts.paused
        ? {
            paused: true,
            matched: { scope: "global", reasonCode: "incident", retryAfterSeconds: 60 },
            matchedChain: [],
          }
        : { paused: false, matched: null, matchedChain: [] },
    ),
  };
  const service = new StellarTxService(
    soroban as unknown as SorobanService,
    signer as unknown as SignerService,
    confirmation as unknown as TxConfirmationService,
    config,
    killSwitch as unknown as KillSwitchService,
  );
  return { service, soroban, signer, confirmation };
}

describe("StellarTxService.extendFootprintTtl (issue #395)", () => {
  it("simulates a single ExtendFootprintTTL op with the keys as a read-only footprint", async () => {
    const { service, soroban } = build();

    await service.extendFootprintTtl(KEYS, 50_000);

    const probe: Transaction = soroban.simulateTransaction.mock.calls[0][0];
    expect(probe.operations).toHaveLength(1);
    expect(probe.operations[0]).toMatchObject({ type: "extendFootprintTtl", extendTo: 50_000 });
    const footprint = probe.toEnvelope().v1().tx().ext().sorobanData().resources().footprint();
    expect(footprint.readOnly().map((k) => k.toXDR("base64"))).toEqual(KEYS.map((k) => k.toXDR("base64")));
    expect(footprint.readWrite()).toHaveLength(0);
  });

  it("signs, submits, confirms and reports the prepared fee", async () => {
    const { service, soroban, signer, confirmation } = build({ preparedFee: "1234" });

    const result = await service.extendFootprintTtl(KEYS, 50_000, { maxFeeStroops: 10_000 });

    expect(result).toEqual({ hash: "abc123", status: "SUCCESS", dryRun: false, feeStroops: 1234 });
    expect(signer.withNextSequence).toHaveBeenCalledTimes(1);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(soroban.submitTransaction).toHaveBeenCalledTimes(1);
    expect(confirmation.waitForConfirmation).toHaveBeenCalledWith("abc123", expect.any(Number));
  });

  it("refuses without consuming a sequence when the estimate exceeds the budget", async () => {
    const { service, signer, soroban } = build({ resourceFee: "5000" });

    const result = await service.extendFootprintTtl(KEYS, 50_000, { maxFeeStroops: 1_000 });

    // estimate = base fee (100) + resource fee (5000)
    expect(result).toEqual({ hash: null, status: "OVER_BUDGET", dryRun: false, feeStroops: 5_100 });
    expect(signer.withNextSequence).not.toHaveBeenCalled();
    expect(soroban.submitTransaction).not.toHaveBeenCalled();
  });

  it("dry run returns the estimate and submits nothing", async () => {
    const { service, signer, soroban } = build({ dryRun: true });

    const result = await service.extendFootprintTtl(KEYS, 50_000);

    expect(result).toEqual({ hash: null, status: "DRY_RUN", dryRun: true, feeStroops: 1_000 });
    expect(signer.withNextSequence).not.toHaveBeenCalled();
    expect(soroban.submitTransaction).not.toHaveBeenCalled();
  });

  it("throws (resetting the sequence) when the prepared fee overruns the budget", async () => {
    const { service, soroban } = build({ resourceFee: "100", preparedFee: "9000" });

    await expect(service.extendFootprintTtl(KEYS, 50_000, { maxFeeStroops: 1_000 })).rejects.toBeInstanceOf(
      TtlExtensionOverBudgetError,
    );
    expect(soroban.submitTransaction).not.toHaveBeenCalled();
  });

  it("fails on a simulation error, an empty key list, or an active kill-switch", async () => {
    const failing = build();
    failing.soroban.simulateTransaction.mockResolvedValue({
      id: "1",
      error: "footprint too large",
      latestLedger: 1,
      events: [],
      _parsed: true,
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse);
    await expect(failing.service.extendFootprintTtl(KEYS, 1)).rejects.toThrow(/footprint too large/);

    await expect(build().service.extendFootprintTtl([], 1)).rejects.toThrow(/no ledger keys/);

    const paused = build({ paused: true });
    await expect(paused.service.extendFootprintTtl(KEYS, 1)).rejects.toBeInstanceOf(KillSwitchActiveException);
    expect(paused.soroban.simulateTransaction).not.toHaveBeenCalled();
  });
});
