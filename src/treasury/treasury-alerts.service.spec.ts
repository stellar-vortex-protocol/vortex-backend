/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for TreasuryService alert lifecycle (issue #treasury-alerts).
 *
 * Covers:
 * - alertDiscrepancy() persists exactly one row per call
 * - alertDiscrepancy() calls delivery.deliver() with the persisted alert
 * - Delivery failures are swallowed — reconciliation loop continues
 * - listAlerts() passes filters to Prisma
 * - acknowledgeAlert() transitions acknowledged: false → true
 * - acknowledgeAlert() is idempotent for an already-acknowledged alert
 * - acknowledgeAlert() throws NotFoundException for unknown id
 */

import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TreasuryService } from "./treasury.service";
import { ITreasuryAlertDelivery } from "./treasury-alert-delivery";
import { ReconciliationResult, TreasuryAlert } from "./treasury.types";

// ── fake Prisma ──────────────────────────────────────────────────────────────

function fakePrisma() {
  const alerts = new Map<string, any>();
  return {
    alerts,
    treasuryAlert: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const row = { ...data, timestamp: new Date(), acknowledged: false };
        alerts.set(data.id, row);
        return row;
      }),
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let rows = [...alerts.values()];
        if (where?.acknowledged !== undefined) rows = rows.filter((r) => r.acknowledged === where.acknowledged);
        if (where?.asset) rows = rows.filter((r) => r.asset === where.asset);
        if (where?.severity) rows = rows.filter((r) => r.severity === where.severity);
        return rows;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => alerts.get(where.id) ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const row = alerts.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
    },
    feeLedger: { findMany: jest.fn().mockResolvedValue([]) },
    slashLedger: { findMany: jest.fn().mockResolvedValue([]) },
    refundLedger: { findMany: jest.fn().mockResolvedValue([]) },
    treasurySnapshot: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReconciliationResult(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    snapshotDate: "2026-10-26",
    asset: "native",
    expectedBalance: "1000000000",
    actualBalance: "1100000000",
    discrepancy: "100000000",
    discrepancyPercentage: 10,
    toleranceThreshold: "10000000",
    hasUnexplainedDiscrepancy: true,
    explanation: "needs investigation",
    breakdown: { fees: "500000000", slashes: "0", refunds: "0" },
    ...overrides,
  };
}

function makeService(prismaOverride?: any, delivery?: ITreasuryAlertDelivery): TreasuryService {
  const prisma = prismaOverride ?? fakePrisma();
  const soroban = {} as any;
  const config = { get: jest.fn().mockReturnValue("") } as unknown as ConfigService<any, true>;
  const svc = new TreasuryService(prisma, soroban, config, delivery);
  // suppress Horizon Server construction error in unit tests
  (svc as any).horizonServer = { loadAccount: jest.fn() };
  (svc as any).treasuryAddress = "GTEST";
  return svc;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("TreasuryService — alert persistence", () => {
  it("persists exactly one alert row per call to alertDiscrepancy()", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);

    await (svc as any).alertDiscrepancy(makeReconciliationResult());

    expect(prisma.treasuryAlert.create).toHaveBeenCalledTimes(1);
    expect(prisma.alerts.size).toBe(1);
    const [row] = [...prisma.alerts.values()];
    expect(row.asset).toBe("native");
    expect(row.severity).toMatch(/^(warning|critical)$/);
    expect(row.acknowledged).toBe(false);
  });

  it("calls delivery.deliver() with the persisted alert", async () => {
    const prisma = fakePrisma();
    const delivery: ITreasuryAlertDelivery = { deliver: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, delivery);

    await (svc as any).alertDiscrepancy(makeReconciliationResult());

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    const delivered = (delivery.deliver as jest.Mock).mock.calls[0][0] as TreasuryAlert;
    expect(delivered.id).toBeDefined();
    expect(delivered.asset).toBe("native");
  });

  it("swallows delivery failures — does not rethrow", async () => {
    const prisma = fakePrisma();
    const delivery: ITreasuryAlertDelivery = {
      deliver: jest.fn().mockRejectedValue(new Error("webhook down")),
    };
    const svc = makeService(prisma, delivery);

    // Must not throw even though delivery fails.
    await expect((svc as any).alertDiscrepancy(makeReconciliationResult())).resolves.toBeUndefined();
    // Alert was still persisted.
    expect(prisma.alerts.size).toBe(1);
  });

  it("assigns 'critical' severity when discrepancy > 5%", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult({ discrepancyPercentage: 10 }));
    const [row] = [...prisma.alerts.values()];
    expect(row.severity).toBe("critical");
  });

  it("assigns 'warning' severity when discrepancy <= 5%", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult({ discrepancyPercentage: 3 }));
    const [row] = [...prisma.alerts.values()];
    expect(row.severity).toBe("warning");
  });
});

describe("TreasuryService — listAlerts()", () => {
  it("returns all alerts when no filters given", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult({ asset: "native" }));
    await (svc as any).alertDiscrepancy(makeReconciliationResult({ asset: "USDC" }));

    const result = await svc.listAlerts();
    expect(result).toHaveLength(2);
  });

  it("filters by asset", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult({ asset: "native" }));
    await (svc as any).alertDiscrepancy(makeReconciliationResult({ asset: "USDC" }));

    const result = await svc.listAlerts({ asset: "native" });
    expect(result).toHaveLength(1);
    expect(result[0].asset).toBe("native");
  });

  it("filters by acknowledged=false", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult());
    const [row] = [...prisma.alerts.values()];
    // Manually mark one as acknowledged in the fake store.
    row.acknowledged = true;

    await (svc as any).alertDiscrepancy(makeReconciliationResult({ asset: "USDC" }));
    const result = await svc.listAlerts({ acknowledged: false });
    expect(result.every((a) => !a.acknowledged)).toBe(true);
  });
});

describe("TreasuryService — acknowledgeAlert()", () => {
  it("transitions acknowledged: false → true", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult());
    const [row] = [...prisma.alerts.values()];

    const result = await svc.acknowledgeAlert(row.id, "ops-admin");
    expect(result.acknowledged).toBe(true);
    expect(prisma.treasuryAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: expect.objectContaining({ acknowledged: true, acknowledgedBy: "ops-admin" }),
      }),
    );
  });

  it("is idempotent — does not call update when already acknowledged", async () => {
    const prisma = fakePrisma();
    const svc = makeService(prisma);
    await (svc as any).alertDiscrepancy(makeReconciliationResult());
    const [row] = [...prisma.alerts.values()];
    row.acknowledged = true; // pre-mark

    const result = await svc.acknowledgeAlert(row.id, "ops-admin");
    expect(result.acknowledged).toBe(true);
    expect(prisma.treasuryAlert.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for an unknown alert id", async () => {
    const svc = makeService();
    await expect(svc.acknowledgeAlert("nonexistent-id", "ops")).rejects.toBeInstanceOf(NotFoundException);
  });
});
