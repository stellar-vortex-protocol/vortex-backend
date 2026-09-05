import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ConfigService } from "@nestjs/config";
import { StellarTxService } from "./stellar-tx.service";
import { SorobanService } from "./soroban.service";
import { AppConfig } from "../config/configuration";

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

describe("StellarTxService", () => {
  let sorobanService: jest.Mocked<Pick<SorobanService, "getFeeStats" | "simulateTransaction" | "prepareTransaction">>;
  let configService: jest.Mocked<Pick<ConfigService<AppConfig, true>, "get">>;
  let service: StellarTxService;

  beforeEach(() => {
    sorobanService = {
      getFeeStats: jest.fn(),
      simulateTransaction: jest.fn(),
      prepareTransaction: jest.fn(),
    };
    configService = { get: jest.fn().mockReturnValue("p50") };
    service = new StellarTxService(
      sorobanService as unknown as SorobanService,
      configService as unknown as ConfigService<AppConfig, true>,
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
        dryRunConfigService,
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

    it("throws when dryRun=false (live path not yet implemented)", async () => {
      const liveConfigService = {
        get: jest.fn((key: string) => {
          if (key === "stellar.feePercentile") return "p50";
          if (key === "onchainDryRun") return false;
          return undefined;
        }),
      } as unknown as ConfigService<AppConfig, true>;

      const liveService = new StellarTxService(
        sorobanService as unknown as SorobanService,
        liveConfigService,
      );

      await expect(
        liveService.invokeContract({
          contractId: "CTEST",
          method: "create_intent",
          args: [],
        }),
      ).rejects.toThrow(/not yet implemented/);
    });
  });
});
