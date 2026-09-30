import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ConfigService } from "@nestjs/config";
import { StellarTxService, type SimulateContractParams } from "./stellar-tx.service";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { AppConfig } from "../config/configuration";
import { KillSwitchService } from "../killswitch/killswitch.service";

function buildTestTransaction(fee = "100"): Transaction {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), "1");
  return new TransactionBuilder(account, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: keypair.publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(30)
    .build();
}

function feeStats(sorobanInclusionFeeP50: string): SorobanRpc.Api.GetFeeStatsResponse {
  const distribution = {
    max: sorobanInclusionFeeP50,
    min: sorobanInclusionFeeP50,
    mode: sorobanInclusionFeeP50,
    p10: sorobanInclusionFeeP50,
    p20: sorobanInclusionFeeP50,
    p30: sorobanInclusionFeeP50,
    p40: sorobanInclusionFeeP50,
    p50: sorobanInclusionFeeP50,
    p60: sorobanInclusionFeeP50,
    p70: sorobanInclusionFeeP50,
    p80: sorobanInclusionFeeP50,
    p90: sorobanInclusionFeeP50,
    p95: sorobanInclusionFeeP50,
    p99: sorobanInclusionFeeP50,
    transactionCount: "1",
    ledgerCount: 1,
  };
  return { sorobanInclusionFee: distribution, inclusionFee: distribution, latestLedger: 1 };
}

function simulationSuccess(minResourceFee: string): SorobanRpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: "1",
    latestLedger: 1,
    events: [],
    _parsed: true,
    minResourceFee,
    transactionData: {} as SorobanRpc.Api.SimulateTransactionSuccessResponse["transactionData"],
    cost: { cpuInsns: "0", memBytes: "0" },
  };
}

function simulationError(message: string): SorobanRpc.Api.SimulateTransactionErrorResponse {
  return { id: "1", error: message, latestLedger: 1, events: [], _parsed: true };
}

/** A syntactically valid contract id (`Address.fromString` must accept it). */
const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * A SignerService stub that satisfies the members StellarTxService actually
 * calls: `getPublicKey`, `withNextSequence` and `sign`.  A bare `{}` double
 * makes those calls throw `is not a function` and masks the real assertion.
 */
function stubSignerService(publicKey = Keypair.random().publicKey()): SignerService {
  return {
    getPublicKey: () => publicKey,
    getNetworkPassphrase: () => Networks.TESTNET,
    withNextSequence: <T>(fn: (sequence: string) => Promise<T>) => fn("0"),
    sign: async <T>(tx: T) => tx,
  } as unknown as SignerService;
}

/** TxConfirmationService stub — confirmation is never really awaited here. */
function stubConfirmationService(): TxConfirmationService {
  return {
    confirm: async () => ({ hash: "stub-hash", status: "SUCCESS", durationMs: 0 }),
    waitForConfirmation: async () => ({ hash: "stub-hash", status: "SUCCESS", durationMs: 0 }),
  } as unknown as TxConfirmationService;
}

/** Width of a transaction's ledger validity window, in seconds. */
function validityWindowSeconds(transaction: Transaction): number {
  const bounds = transaction.timeBounds;
  if (!bounds) throw new Error("expected the simulation envelope to carry a validity window");
  // `TransactionBuilder.setTimeout(n)` does not store a width: it writes
  // `{ minTime: 0, maxTime: <unix seconds now> + n }`, leaving the lower bound
  // at 0 for the ledger to read as "now". Resolving that 0 against the wall
  // clock is what turns the pair back into the width the caller asked for —
  // subtracting 0 - 0 would report an epoch timestamp instead.
  const lowerBound = Number(bounds.minTime) || Math.floor(Date.now() / 1000);
  return Number(bounds.maxTime) - lowerBound;
}

/**
 * Pin `Date.now()` so the `setTimeout`-derived `maxTime` in the simulation
 * envelope is reproducible and the window width above is exact rather than
 * ±1 s depending on where in the second the assertion runs.
 *
 * Only `Date.now` is stubbed; real timers, promises and I/O are untouched.
 */
function freezeClock(ms = Date.UTC(2026, 0, 1)): void {
  jest.spyOn(Date, "now").mockReturnValue(ms);
}

describe("StellarTxService", () => {
  let sorobanService: jest.Mocked<Pick<SorobanService, "getFeeStats" | "simulateTransaction" | "prepareTransaction">>;
  let configService: jest.Mocked<Pick<ConfigService<AppConfig, true>, "get">>;
  let killSwitch: { evaluateTarget: jest.Mock };
  let service: StellarTxService;

  /** Default: no pause active, so pre-existing behaviour is unchanged. */
  const notPaused = { paused: false, matched: null, matchedChain: [] };

  /**
   * `signerService` and `confirmationService` are only touched on the live
   * submit path; the fee/dry-run/simulation paths exercised here never reach
   * them, so empty stand-ins keep the constructor honest about its arity.
   */
  const unusedSigner = {} as unknown as SignerService;
  const unusedConfirmation = {} as unknown as TxConfirmationService;

  beforeEach(() => {
    sorobanService = {
      getFeeStats: jest.fn(),
      simulateTransaction: jest.fn(),
      prepareTransaction: jest.fn(),
    };
    configService = { get: jest.fn().mockReturnValue("p50") };
    killSwitch = { evaluateTarget: jest.fn().mockReturnValue(notPaused) };
    service = new StellarTxService(
      sorobanService as unknown as SorobanService,
      unusedSigner,
      unusedConfirmation,
      stubSignerService(),
      stubConfirmationService(),
      configService as unknown as ConfigService<AppConfig, true>,
      killSwitch as unknown as KillSwitchService,
    );
  });

  describe("estimateBaseFee", () => {
    it("returns the configured fee percentile from network fee stats", async () => {
      sorobanService.getFeeStats.mockResolvedValue(feeStats("250"));

      await expect(service.estimateBaseFee()).resolves.toBe("250");
    });

    it("falls back to BASE_FEE when the reported fee is 0", async () => {
      sorobanService.getFeeStats.mockResolvedValue(feeStats("0"));

      await expect(service.estimateBaseFee()).resolves.toBe(BASE_FEE);
    });

    it("falls back to BASE_FEE when fee stats are unavailable", async () => {
      sorobanService.getFeeStats.mockRejectedValue(new Error("rpc unavailable"));

      await expect(service.estimateBaseFee()).resolves.toBe(BASE_FEE);
    });
  });

  describe("estimateFee", () => {
    it("combines the network base fee with the simulated resource fee", async () => {
      sorobanService.getFeeStats.mockResolvedValue(feeStats("300"));
      sorobanService.simulateTransaction.mockResolvedValue(simulationSuccess("45000"));

      const estimate = await service.estimateFee(buildTestTransaction());

      expect(estimate).toEqual({ baseFee: "300", resourceFee: "45000", totalFee: "45300" });
    });

    it("throws when simulation fails, without marking anything as prepared", async () => {
      sorobanService.getFeeStats.mockResolvedValue(feeStats("300"));
      sorobanService.simulateTransaction.mockResolvedValue(simulationError("boom"));

      await expect(service.estimateFee(buildTestTransaction())).rejects.toThrow(/simulation error: boom/);
      expect(sorobanService.prepareTransaction).not.toHaveBeenCalled();
    });
  });

  describe("prepareTransaction", () => {
    it("submits the transaction with the estimated base fee applied", async () => {
      sorobanService.getFeeStats.mockResolvedValue(feeStats("300"));
      const prepared = buildTestTransaction("45300");
      sorobanService.prepareTransaction.mockResolvedValue(prepared);

      const result = await service.prepareTransaction(buildTestTransaction());

      expect(result).toBe(prepared);
      const [submittedTx] = sorobanService.prepareTransaction.mock.calls[0];
      expect((submittedTx as Transaction).fee).toBe("300");
    });
  });

  describe("invokeContract — dry-run mode (#260)", () => {
    it("returns dryRun:true without calling any soroban method when dryRun=true", async () => {
      // configService returns dryRun=true for onchainDryRun
      const dryRunConfigService = {
        get: jest.fn((key: string) => {
          if (key === "stellar.feePercentile") return "p50";
          if (key === "onchainDryRun") return true;
          return undefined;
        }),
      } as unknown as ConfigService<AppConfig, true>;

      const dryRunService = new StellarTxService(
        sorobanService as unknown as SorobanService,
        unusedSigner,
        unusedConfirmation,
        stubSignerService(),
        stubConfirmationService(),
        dryRunConfigService,
        killSwitch as unknown as KillSwitchService,
      );

      const result = await dryRunService.invokeContract({
        contractId: "CTEST",
        method: "create_intent",
        args: [],
      });

      expect(result.dryRun).toBe(true);
      expect(result.status).toBe("DRY_RUN");
      // No network calls should be made in dry-run mode
      expect(sorobanService.simulateTransaction).not.toHaveBeenCalled();
      expect(sorobanService.prepareTransaction).not.toHaveBeenCalled();
    });

    it("signs, submits and confirms when dryRun=false (live path)", async () => {
      // NOTE: this test used to assert the live path threw "not yet
      // implemented". That branch is gone — `invokeContract` now runs the full
      // simulate → prepare → sign → submit → confirm pipeline, so the
      // assertion is stated against what the service actually does today.
      const liveConfigService = {
        get: jest.fn((key: string) => {
          if (key === "stellar.feePercentile") return "p50";
          if (key === "onchainDryRun") return false;
          return undefined;
        }),
      } as unknown as ConfigService<AppConfig, true>;

      const liveSoroban = {
        getFeeStats: jest.fn().mockResolvedValue(feeStats("100")),
        simulateTransaction: jest.fn().mockResolvedValue(simulationSuccess("45000")),
        prepareTransaction: jest.fn().mockImplementation(async (tx: Transaction) => tx),
        submitTransaction: jest.fn().mockResolvedValue({ hash: "live-hash", status: "SUCCESS" }),
      };
      const confirmation = {
        waitForConfirmation: jest
          .fn()
          .mockResolvedValue({ hash: "live-hash", status: "SUCCESS", durationMs: 12 }),
      };

      const liveService = new StellarTxService(
        sorobanService as unknown as SorobanService,
        {
          // The live path hands the envelope to the signer; this suite only
          // asserts the dry-run gate releases control to it.
          withNextSequence: jest.fn().mockRejectedValue(new Error("not yet implemented")),
        } as unknown as SignerService,
        unusedConfirmation,
        liveSoroban as unknown as SorobanService,
        stubSignerService(),
        confirmation as unknown as TxConfirmationService,
        liveConfigService,
        killSwitch as unknown as KillSwitchService,
      );

      // A real contract id: the SDK rejects a placeholder in `new Contract(..)`
      // before the live branch ever gets to do anything meaningful.
      await expect(
        liveService.invokeContract({
          contractId: CONTRACT_ID,
          method: "create_intent",
          args: [],
        }),
      ).resolves.toEqual({ hash: "live-hash", status: "SUCCESS", dryRun: false, restored: false });

      expect(liveSoroban.submitTransaction).toHaveBeenCalledTimes(1);
      expect(confirmation.waitForConfirmation).toHaveBeenCalledTimes(1);
    });
  });

  describe("simulateContract (#401 read-only shadow primitive)", () => {
    const sourceKeypair = Keypair.random();

    // `freezeClock()` is opt-in per test; always drop the `Date.now` stub.
    afterEach(() => {
      jest.restoreAllMocks();
    });

    type SimulateDeps = jest.Mocked<
      Pick<
        SorobanService,
        "getFeeStats" | "simulateTransaction" | "getAccount" | "getLatestLedger" | "prepareTransaction" | "submitTransaction"
      >
    >;

    function buildShadowService(
      config: {
        queueMax?: unknown;
        concurrency?: unknown;
        onchainDryRun?: boolean;
      } = {},
    ): { service: StellarTxService; soroban: SimulateDeps } {
      const soroban: SimulateDeps = {
        getFeeStats: jest.fn().mockResolvedValue(feeStats("100")),
        simulateTransaction: jest.fn(),
        getAccount: jest.fn().mockResolvedValue(new Account(sourceKeypair.publicKey(), "42")),
        getLatestLedger: jest.fn().mockResolvedValue({ id: "1", sequence: "500" }),
        prepareTransaction: jest.fn(),
        submitTransaction: jest.fn(),
      };

      const configService = {
        get: jest.fn((key: string) => {
          if (key === "stellar.feePercentile") return "p50";
          if (key === "stellar.network") return "testnet";
          if (key === "onchainDryRun") return config.onchainDryRun ?? true;
          if (key === "shadow.queueMax") return config.queueMax;
          if (key === "shadow.concurrency") return config.concurrency;
          return undefined;
        }),
      } as unknown as ConfigService<AppConfig, true>;

      return {
        service: new StellarTxService(
          soroban as unknown as SorobanService,
          unusedSigner,
          unusedConfirmation,
          configService,
          { evaluateTarget: () => notPaused } as unknown as KillSwitchService,
          stubSignerService(),
          stubConfirmationService(),
          configService,
          {} as unknown as KillSwitchService,
        ),
        soroban,
      };
    }

    function params(overrides: Partial<SimulateContractParams> = {}): SimulateContractParams {
      return {
        contractId: CONTRACT_ID,
        method: "accept_intent",
        args: [nativeToScVal("intent-1", { type: "string" })],
        sourceAccount: sourceKeypair.publicKey(),
        ...overrides,
      };
    }

    it("reports ok when the contract would have accepted the call", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("45000"));

      await expect(service.simulateContract(params())).resolves.toEqual({ outcome: "ok" });
    });

    it("never prepares or submits anything — the envelope is unsigned and unbroadcast", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("45000"));

      await service.simulateContract(params());

      expect(soroban.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(soroban.prepareTransaction).not.toHaveBeenCalled();
      expect(soroban.submitTransaction).not.toHaveBeenCalled();
    });

    it("simulates even with ONCHAIN_DRY_RUN unset, because dry-run governs broadcast", async () => {
      const { service, soroban } = buildShadowService({ onchainDryRun: false });
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("45000"));

      await expect(service.simulateContract(params())).resolves.toEqual({ outcome: "ok" });
    });

    it("skips rather than guesses when no source account is configured", async () => {
      const { service, soroban } = buildShadowService();

      const result = await service.simulateContract(params({ sourceAccount: "  " }));

      expect(result.outcome).toBe("skipped");
      expect(result.detail).toMatch(/source account/i);
      expect(soroban.simulateTransaction).not.toHaveBeenCalled();
    });

    it("skips when no settlement contract is configured", async () => {
      const { service, soroban } = buildShadowService();

      const result = await service.simulateContract(params({ contractId: "" }));

      expect(result.outcome).toBe("skipped");
      expect(result.detail).toMatch(/contract/i);
      expect(soroban.simulateTransaction).not.toHaveBeenCalled();
    });

    it("classifies a contract guard failure as a rejection, not an error", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockResolvedValue(
        simulationError("HostError: Error(Contract, #1) insufficient balance"),
      );

      const result = await service.simulateContract(params());

      expect(result.outcome).toBe("rejected");
      expect(result.detail).toContain("insufficient balance");
    });

    it("classifies a hard failure as a contract error", async () => {
      const { service, soroban } = buildShadowService();
      // Deliberately carries none of the revert markers the classifier keys on
      // ("error(contract", "error(wasmvm", "revert"): the host reached the
      // contract and it failed outright rather than refusing the call.
      soroban.simulateTransaction.mockResolvedValue(
        simulationError("HostError: Error(Context, InvalidAction) missing export"),
      );

      const result = await service.simulateContract(params());

      expect(result.outcome).toBe("error");
      expect(result.detail).toContain("missing export");
    });

    it("reports an unreachable RPC as unavailable, not as a contract failure", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockRejectedValue(new Error("connect ECONNREFUSED"));

      const result = await service.simulateContract(params());

      expect(result.outcome).toBe("unavailable");
      expect(result.detail).toContain("ECONNREFUSED");
    });

    it("reports an empty response as unavailable", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockResolvedValue(
        undefined as unknown as SorobanRpc.Api.SimulateTransactionResponse,
      );

      await expect(service.simulateContract(params())).resolves.toMatchObject({
        outcome: "unavailable",
      });
    });

    it("reports an unbuildable envelope as unavailable without asking the contract", async () => {
      const { service, soroban } = buildShadowService();

      const result = await service.simulateContract(params({ contractId: "not-a-contract-id" }));

      expect(result.outcome).toBe("unavailable");
      expect(result.detail).toMatch(/could not build/i);
      expect(soroban.simulateTransaction).not.toHaveBeenCalled();
    });

    it("uses the source account's real sequence number when it is on chain", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));

      await service.simulateContract(params());

      const [submitted] = soroban.simulateTransaction.mock.calls[0];
      expect((submitted as Transaction).sequence).toBe("42");
      // The account is at 42, and a Stellar transaction must carry the *next*
      // sequence to use, so the SDK's TransactionBuilder bumps it by one.
      expect((submitted as Transaction).sequence).toBe("43");
      expect(soroban.getLatestLedger).not.toHaveBeenCalled();
    });

    it("falls back to the latest ledger for a source account that has never been on chain", async () => {
      const { service, soroban } = buildShadowService();
      soroban.getAccount.mockRejectedValue(new Error("not found"));
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));

      await service.simulateContract(params());

      const [submitted] = soroban.simulateTransaction.mock.calls[0];
      // 500 (latest closed) + 1: the next sequence the account would hold.
      expect((submitted as Transaction).sequence).toBe("501");
      // Ledger 500 → the service offers 501 as the account's sequence, and the
      // builder adds the transaction-level +1 on top.
      expect((submitted as Transaction).sequence).toBe("502");
    });

    it("falls back to sequence 0 when neither the account nor the ledger can be read", async () => {
      const { service, soroban } = buildShadowService();
      soroban.getAccount.mockRejectedValue(new Error("not found"));
      soroban.getLatestLedger.mockRejectedValue(new Error("rpc down"));
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));

      const result = await service.simulateContract(params());

      expect(result.outcome).toBe("ok");
      const [submitted] = soroban.simulateTransaction.mock.calls[0];
      expect((submitted as Transaction).sequence).toBe("0");
      // Base sequence 0, plus the builder's transaction-level +1.
      expect((submitted as Transaction).sequence).toBe("1");
    });

    // Regression guard for a real defect that was fixed: the service used to
    // build its operation with the stellar-sdk 11 shape
    //   Operation.invokeHostFunction({ func: xdr.HostFunctionType.hostFunctionTypeInvokeContract, args: [...] })
    // which stellar-sdk 12.x does not accept — `func` must be a constructed
    // `xdr.HostFunction` and `args` is not a top-level option at all. The
    // resulting envelope could not be XDR-encoded ("() => inst has union name
    // undefined, not HostFunction"), so every shadow simulation the monitor put
    // on the wire was malformed. The `toXDR()` assertion below is what proves
    // the envelope is now structurally valid.
    it("builds a single, well-formed host-function operation for the named method", async () => {
      const { service, soroban } = buildShadowService();
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));

      const result = await service.simulateContract(params({ method: "fill_intent" }));

      expect(result.outcome).toBe("ok");
      const [submitted] = soroban.simulateTransaction.mock.calls[0];
      const tx = submitted as Transaction;
      expect(tx.operations).toHaveLength(1);
      const envelope = (submitted as Transaction).toEnvelope();
      expect((envelope.value() as xdr.TransactionV1Envelope).tx().operations()).toHaveLength(1);
      // Round-trips through XDR, so the host function and every ScVal the
      // monitor built are structurally valid — which is the whole reason the
      // monitor cannot blame a malformed envelope for a "divergence".
      expect(() => tx.toXDR()).not.toThrow();
    });

    it("sizes the ledger validity window from the worst-case shadow queue drain", async () => {
      // 1000 queued at 4-way concurrency = 250 sequential batches; at an
      // assumed 3 s per simulation that is 750 s, plus 60 s of slack.
      const { service, soroban } = buildShadowService({ queueMax: 1000, concurrency: 4 });
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));
      freezeClock();

      await service.simulateContract(params());

      const [submitted] = soroban.simulateTransaction.mock.calls[0];
      expect(validityWindowSeconds(submitted as Transaction)).toBe(810);
    });

    it("clamps the validity window to a ledger-acceptable range", async () => {
      // Floor: 256 queued at 4-way concurrency is well under a minute of
      // drain, so the 300 s minimum applies.
      const small = buildShadowService({ queueMax: 256, concurrency: 4 });
      small.soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));
      freezeClock();
      await small.service.simulateContract(params());
      const [smallTx] = small.soroban.simulateTransaction.mock.calls[0];
      expect(validityWindowSeconds(smallTx as Transaction)).toBe(300);

      // Ceiling: an absurd queue must not produce an absurd window.
      const huge = buildShadowService({ queueMax: 1_000_000, concurrency: 1 });
      huge.soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));
      freezeClock();
      await huge.service.simulateContract(params());
      const [hugeTx] = huge.soroban.simulateTransaction.mock.calls[0];
      expect(validityWindowSeconds(hugeTx as Transaction)).toBe(3600);
    });

    it("still builds a valid envelope when the queue settings are unparseable", async () => {
      const { service, soroban } = buildShadowService({ queueMax: "many", concurrency: NaN });
      soroban.simulateTransaction.mockResolvedValue(simulationSuccess("1"));
      freezeClock();

      const result = await service.simulateContract(params());

      expect(result.outcome).toBe("ok");
      const [submitted] = soroban.simulateTransaction.mock.calls[0];
      expect(validityWindowSeconds(submitted as Transaction)).toBe(300);
    });

    it("never throws, whatever the RPC does", async () => {
      const { service, soroban } = buildShadowService();
      soroban.getFeeStats.mockRejectedValue(new Error("fee stats down"));

      await expect(service.simulateContract(params())).resolves.toMatchObject({
        outcome: "unavailable",
      });
    });
  });
});
