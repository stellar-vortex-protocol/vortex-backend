import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { TreasuryService } from "./treasury.service";
import { PrismaService } from "../prisma/prisma.service";
import { SorobanService } from "../soroban/soroban.service";

/**
 * The Prisma delegates this suite stubs. `jest.Mocked<T>` is shallow, so the
 * model delegates (objects, not methods) would keep their real Prisma types;
 * this local shape keeps every stub a `jest.Mock` with `mockResolvedValue`.
 */
type MockPrisma = {
  feeLedger: { create: jest.Mock; findMany: jest.Mock };
  slashLedger: { create: jest.Mock; findMany: jest.Mock };
  refundLedger: { create: jest.Mock; findMany: jest.Mock };
  treasurySnapshot: { upsert: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
};

describe("TreasuryService", () => {
  let service: TreasuryService;
  let prisma: MockPrisma;
  // The mock Prisma only carries the ledger delegates the service touches;
  // type as `any` so the per-method `mockResolvedValue` calls type-check
  // (jest.Mocked does not deep-transform nested Prisma delegates).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let soroban: jest.Mocked<SorobanService>;
  let configService: jest.Mocked<ConfigService>;

  const mockTreasuryAddress = "GTREASURY123456789";

  beforeEach(async () => {
    const mockPrisma = {
      feeLedger: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      slashLedger: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      refundLedger: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      treasurySnapshot: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "treasury.address") return mockTreasuryAddress;
        if (key === "stellar.horizonUrl") return "https://horizon-testnet.stellar.org";
        if (key === "stellar.sorobanRpcUrl") return "https://soroban-testnet.stellar.org";
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TreasuryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SorobanService, useValue: {} },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<TreasuryService>(TreasuryService);
    prisma = mockPrisma;
    // The mock Prisma only carries the ledger delegates the service touches;
    // cast to `any` so the per-method `mockResolvedValue` calls type-check
    // (jest.Mocked does not deep-transform nested Prisma delegates).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma = module.get(PrismaService) as any;
    soroban = module.get(SorobanService) as jest.Mocked<SorobanService>;
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("recordFee", () => {
    it("should record a fee in the ledger", async () => {
      const feeEntry = {
        intentId: "intent-123",
        asset: "native",
        amount: "1000000",
        accrualAt: new Date(),
        txHash: "tx-hash",
      };

      prisma.feeLedger.create.mockResolvedValue({
        id: 1n,
        ...feeEntry,
      } as any);

      await service.recordFee(feeEntry);

      expect(prisma.feeLedger.create).toHaveBeenCalledWith({
        data: feeEntry,
      });
    });
  });

  describe("recordSlash", () => {
    it("should record a slash in the ledger", async () => {
      const slashEntry = {
        solverAddress: "solver-123",
        asset: "native",
        amount: "5000000",
        slashedAt: new Date(),
        reason: "Missed deadline",
        txHash: "tx-hash",
      };

      prisma.slashLedger.create.mockResolvedValue({
        id: 1n,
        ...slashEntry,
      } as any);

      await service.recordSlash(slashEntry);

      expect(prisma.slashLedger.create).toHaveBeenCalledWith({
        data: slashEntry,
      });
    });
  });

  describe("recordRefund", () => {
    it("should record a refund in the ledger", async () => {
      const refundEntry = {
        intentId: "intent-123",
        userAddress: "user-123",
        asset: "native",
        amount: "2000000",
        issuedAt: new Date(),
        reason: "Failed transaction",
        txHash: "tx-hash",
      };

      prisma.refundLedger.create.mockResolvedValue({
        id: 1n,
        ...refundEntry,
      } as any);

      await service.recordRefund(refundEntry);

      expect(prisma.refundLedger.create).toHaveBeenCalledWith({
        data: refundEntry,
      });
    });
  });

  describe("calculateExpectedBalance", () => {
    it("should calculate expected balance from ledgers", async () => {
      const asset = "native";
      const now = new Date();

      prisma.feeLedger.findMany.mockResolvedValue([
        { id: 1n, intentId: "i1", asset, amount: "1000000", accrualAt: now, txHash: null },
        { id: 2n, intentId: "i2", asset, amount: "2000000", accrualAt: now, txHash: null },
      ] as any);

      prisma.slashLedger.findMany.mockResolvedValue([
        {
          id: 1n,
          solverAddress: "s1",
          asset,
          amount: "500000",
          slashedAt: now,
          reason: "test",
          txHash: null,
        },
      ] as any);

      prisma.refundLedger.findMany.mockResolvedValue([
        {
          id: 1n,
          intentId: "i3",
          userAddress: "u1",
          asset,
          amount: "300000",
          issuedAt: now,
          reason: "test",
          txHash: null,
        },
      ] as any);

      const result = await service.calculateExpectedBalance(asset);

      // 1000000 + 2000000 + 500000 - 300000 = 3200000
      expect(result).toEqual({
        asset: "native",
        totalFees: "3000000",
        totalSlashes: "500000",
        totalRefunds: "300000",
        netExpected: "3200000",
      });
    });

    it("should handle empty ledgers", async () => {
      const asset = "USDC";

      prisma.feeLedger.findMany.mockResolvedValue([]);
      prisma.slashLedger.findMany.mockResolvedValue([]);
      prisma.refundLedger.findMany.mockResolvedValue([]);

      const result = await service.calculateExpectedBalance(asset);

      expect(result).toEqual({
        asset: "USDC",
        totalFees: "0",
        totalSlashes: "0",
        totalRefunds: "0",
        netExpected: "0",
      });
    });
  });

  describe("reconcileAsset", () => {
    it("should reconcile asset and detect no discrepancy", async () => {
      const asset = "native";
      const date = new Date("2026-09-28");
      const expectedBalance = "10000000"; // 1 XLM

      // Mock expected balance calculation
      prisma.feeLedger.findMany.mockResolvedValue([
        {
          id: 1n,
          intentId: "i1",
          asset,
          amount: expectedBalance,
          accrualAt: date,
          txHash: null,
        },
      ] as any);
      prisma.slashLedger.findMany.mockResolvedValue([]);
      prisma.refundLedger.findMany.mockResolvedValue([]);

      // Mock actual balance fetch
      jest.spyOn(service as any, "fetchActualBalance").mockResolvedValue({
        asset,
        balance: expectedBalance,
      });

      prisma.treasurySnapshot.upsert.mockResolvedValue({} as any);

      const result = await service.reconcileAsset(asset, date);

      expect(result).toMatchObject({
        snapshotDate: "2026-09-28",
        asset: "native",
        expectedBalance: expectedBalance,
        actualBalance: expectedBalance,
        discrepancy: "0",
        hasUnexplainedDiscrepancy: false,
      });
    });

    it("should detect discrepancy within tolerance", async () => {
      const asset = "native";
      const date = new Date("2026-09-28");
      const expectedBalance = "100000000"; // 10 XLM
      const actualBalance = "100500000"; // 10.05 XLM (0.5% higher)

      prisma.feeLedger.findMany.mockResolvedValue([
        {
          id: 1n,
          intentId: "i1",
          asset,
          amount: expectedBalance,
          accrualAt: date,
          txHash: null,
        },
      ] as any);
      prisma.slashLedger.findMany.mockResolvedValue([]);
      prisma.refundLedger.findMany.mockResolvedValue([]);

      jest.spyOn(service as any, "fetchActualBalance").mockResolvedValue({
        asset,
        balance: actualBalance,
      });

      prisma.treasurySnapshot.upsert.mockResolvedValue({} as any);

      const result = await service.reconcileAsset(asset, date);

      // Discrepancy is 500000 stroops (0.05 XLM), which is < tolerance of 10000000 (1 XLM)
      expect(result).toMatchObject({
        asset: "native",
        discrepancy: "500000",
        hasUnexplainedDiscrepancy: false,
      });
    });

    it("should detect unexplained discrepancy exceeding tolerance", async () => {
      const asset = "native";
      const date = new Date("2026-09-28");
      const expectedBalance = "100000000"; // 10 XLM
      const actualBalance = "150000000"; // 15 XLM (5 XLM higher, exceeds 1 XLM tolerance)

      prisma.feeLedger.findMany.mockResolvedValue([
        {
          id: 1n,
          intentId: "i1",
          asset,
          amount: expectedBalance,
          accrualAt: date,
          txHash: null,
        },
      ] as any);
      prisma.slashLedger.findMany.mockResolvedValue([]);
      prisma.refundLedger.findMany.mockResolvedValue([]);

      jest.spyOn(service as any, "fetchActualBalance").mockResolvedValue({
        asset,
        balance: actualBalance,
      });

      prisma.treasurySnapshot.upsert.mockResolvedValue({} as any);

      const alertSpy = jest.spyOn(service as any, "alertDiscrepancy").mockResolvedValue(undefined);

      const result = await service.reconcileAsset(asset, date);

      expect(result).toMatchObject({
        asset: "native",
        discrepancy: "50000000",
        hasUnexplainedDiscrepancy: true,
      });

      expect(alertSpy).toHaveBeenCalled();
    });

    it("should handle negative discrepancy (actual < expected)", async () => {
      const asset = "native";
      const date = new Date("2026-09-28");
      const expectedBalance = "100000000"; // 10 XLM
      const actualBalance = "50000000"; // 5 XLM (5 XLM lower)

      prisma.feeLedger.findMany.mockResolvedValue([
        {
          id: 1n,
          intentId: "i1",
          asset,
          amount: expectedBalance,
          accrualAt: date,
          txHash: null,
        },
      ] as any);
      prisma.slashLedger.findMany.mockResolvedValue([]);
      prisma.refundLedger.findMany.mockResolvedValue([]);

      jest.spyOn(service as any, "fetchActualBalance").mockResolvedValue({
        asset,
        balance: actualBalance,
      });

      prisma.treasurySnapshot.upsert.mockResolvedValue({} as any);

      const result = await service.reconcileAsset(asset, date);

      expect(result).toMatchObject({
        asset: "native",
        discrepancy: "-50000000",
        hasUnexplainedDiscrepancy: true,
      });
    });
  });

  describe("getReconciliationSummary", () => {
    it("should return reconciliation summary for a date", async () => {
      const snapshotDate = "2026-09-28";
      const mockSnapshots = [
        {
          id: 1n,
          snapshotDate,
          asset: "native",
          expectedBalance: "100000000",
          actualBalance: "100000000",
          discrepancy: "0",
          toleranceThreshold: "10000000",
          hasUnexplainedDiscrepancy: false,
          explanation: "Balances match exactly.",
          createdAt: new Date("2026-09-28T00:00:00Z"),
          breakdown: {
            fees: "100000000",
            slashes: "0",
            refunds: "0",
          },
        },
        {
          id: 2n,
          snapshotDate,
          asset: "USDC",
          expectedBalance: "50000000",
          actualBalance: "52000000",
          discrepancy: "2000000",
          toleranceThreshold: "1000000",
          hasUnexplainedDiscrepancy: true,
          explanation: "Exceeds tolerance.",
          createdAt: new Date("2026-09-28T00:00:00Z"),
          breakdown: {
            fees: "50000000",
            slashes: "0",
            refunds: "0",
          },
        },
      ];

      prisma.treasurySnapshot.findMany.mockResolvedValue(mockSnapshots as any);

      const summary = await service.getReconciliationSummary(snapshotDate);

      expect(summary).toMatchObject({
        date: snapshotDate,
        totalDiscrepancies: 1,
        assetsWithUnexplainedDiscrepancies: 1,
      });

      expect(summary.assets).toHaveLength(2);
      expect(summary.assets[0].asset).toBe("native");
      expect(summary.assets[1].asset).toBe("USDC");
    });
  });

  describe("getReconciliationDetail", () => {
    it("should return detailed reconciliation for an asset", async () => {
      const snapshotDate = "2026-09-28";
      const asset = "native";

      const mockSnapshot = {
        id: 1n,
        snapshotDate,
        asset,
        expectedBalance: "100000000",
        actualBalance: "100500000",
        discrepancy: "500000",
        toleranceThreshold: "10000000",
        hasUnexplainedDiscrepancy: false,
        explanation: "Within tolerance.",
        createdAt: new Date("2026-09-28T00:00:00Z"),
        breakdown: {
          fees: "100000000",
          slashes: "0",
          refunds: "0",
        },
      };

      prisma.treasurySnapshot.findUnique.mockResolvedValue(mockSnapshot as any);

      const mockFees = [
        {
          id: 1n,
          intentId: "i1",
          asset,
          amount: "50000000",
          accrualAt: new Date("2026-09-27T12:00:00Z"),
          txHash: "tx1",
        },
      ];

      const mockSlashes = [
        {
          id: 1n,
          solverAddress: "s1",
          asset,
          amount: "10000000",
          slashedAt: new Date("2026-09-27T13:00:00Z"),
          reason: "Timeout",
          txHash: "tx2",
        },
      ];

      const mockRefunds = [
        {
          id: 1n,
          intentId: "i2",
          userAddress: "u1",
          asset,
          amount: "5000000",
          issuedAt: new Date("2026-09-27T14:00:00Z"),
          reason: "Failed tx",
          txHash: "tx3",
        },
      ];

      prisma.feeLedger.findMany.mockResolvedValue(mockFees as any);
      prisma.slashLedger.findMany.mockResolvedValue(mockSlashes as any);
      prisma.refundLedger.findMany.mockResolvedValue(mockRefunds as any);

      const detail = await service.getReconciliationDetail(asset, snapshotDate);

      expect(detail).toMatchObject({
        snapshotDate,
        asset,
        expectedBalance: "100000000",
        actualBalance: "100500000",
        discrepancy: "500000",
      });

      expect(detail.recentTransactions).toHaveLength(3);
      expect(detail.recentTransactions[0].type).toBe("refund");
      expect(detail.recentTransactions[1].type).toBe("slash");
      expect(detail.recentTransactions[2].type).toBe("fee");
    });

    it("should throw error if snapshot not found", async () => {
      prisma.treasurySnapshot.findUnique.mockResolvedValue(null);

      await expect(
        service.getReconciliationDetail("nonexistent", "2026-09-28"),
      ).rejects.toThrow("No reconciliation found");
    });
  });
});
