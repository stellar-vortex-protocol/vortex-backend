import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { ProtocolParamsService } from "../governance/params.service";
import { AuditPartitionService, monthStart, monthSuffix, partitionMonth } from "./audit-partition.service";
import { AUDIT_CLOCK_SKEW_SECONDS, IntentsService } from "./intents.service";
import { InMemoryIntentsRepository } from "./intents.repository";

/**
 * Issue #407 — unit coverage for the partition helpers, the no-op paths and
 * the persisted audit read. The SQL itself runs against Postgres in
 * src/scripts/audit-partitions.spec.ts (TEST_DATABASE_URL).
 */

describe("audit partition helpers (issue #407)", () => {
  it("computes UTC month starts across year boundaries", () => {
    expect(monthStart(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-12-31T23:59:59Z"), 1).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-01-15T00:00:00Z"), -13).toISOString()).toBe("2024-12-01T00:00:00.000Z");
  });

  it("round-trips partition names", () => {
    expect(monthSuffix(new Date("2026-03-09T00:00:00Z"))).toBe("y2026m03");
    expect(partitionMonth("intent_audit_log_y2026m03")?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(partitionMonth("intent_audit_log_detached_y2025m11")?.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(partitionMonth("intent_audit_log_default")).toBeUndefined();
    expect(partitionMonth("intent_audit_log_y2026m3")).toBeUndefined();
  });
});

describe("AuditPartitionService no-op paths", () => {
  const config = {
    get: () => ({ maintenanceEnabled: true, intervalMs: 60_000, premakeMonths: 3, retentionMonths: 0, dropAfterExport: false }),
  } as unknown as ConfigService<AppConfig, true>;

  it("does nothing without raw SQL (e2e mocks)", async () => {
    const service = new AuditPartitionService({} as PrismaService, config);
    expect(await service.run()).toMatchObject({ parent: null, created: [], errors: [] });
  });

  it("does nothing when no partitioned audit table exists yet", async () => {
    const $queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const service = new AuditPartitionService({ $queryRawUnsafe } as unknown as PrismaService, config);
    expect((await service.run()).parent).toBeNull();
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("does not register with leader election when maintenance is disabled", () => {
    const off = { get: () => ({ maintenanceEnabled: false }) } as unknown as ConfigService<AppConfig, true>;
    const leaderElection = { registerWorker: jest.fn() };
    new AuditPartitionService({} as PrismaService, off, leaderElection as never).onModuleInit();
    expect(leaderElection.registerWorker).not.toHaveBeenCalled();
  });
});

describe("IntentsService.getAuditTrail (issue #407)", () => {
  function build(audit: Record<string, unknown>) {
    const config = { get: () => undefined } as unknown as ConfigService<AppConfig, true>;
    return new IntentsService(
      new InMemoryIntentsRepository({ seed: false }),
      config,
      {} as StellarTxService,
      { intentAuditLog: { create: jest.fn().mockResolvedValue({}), ...audit } } as unknown as PrismaService,
      {} as ProtocolParamsService,
    );
  }

  it("serves the in-memory log when this replica has entries", async () => {
    const findMany = jest.fn();
    const service = build({ findMany });
    service.appendAuditEntry("i-1", "cancelled", "GUSER", "user cancelled");
    const trail = await service.getAuditTrail({ intentId: "i-1", createdAt: 1_700_000_000 }, 20, 0);
    expect(trail.total).toBe(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("falls back to the table with a lower timestamp bound so partitions are pruned", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const findMany = jest.fn().mockResolvedValue([
      { timestamp: at, toState: "accepted", actor: "GSOLVER", reason: "solver accepted", metadata: { deadline: 5 } },
    ]);
    const count = jest.fn().mockResolvedValue(7);
    const service = build({ findMany, count });

    const trail = await service.getAuditTrail({ intentId: "i-2", createdAt: 1_790_000_000 }, 20, 5);

    const where = {
      intentId: "i-2",
      timestamp: { gte: new Date((1_790_000_000 - AUDIT_CLOCK_SKEW_SECONDS) * 1000) },
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 5, take: 20 }));
    expect(count).toHaveBeenCalledWith({ where });
    expect(trail).toEqual({
      total: 7,
      entries: [
        {
          timestamp: at.toISOString(),
          toState: "accepted",
          actor: "GSOLVER",
          reason: "solver accepted",
          metadata: { deadline: 5 },
        },
      ],
    });
  });

  it("returns an empty trail when the table read fails", async () => {
    const service = build({ findMany: jest.fn().mockRejectedValue(new Error("db down")) });
    expect(await service.getAuditTrail({ intentId: "i-3", createdAt: 0 }, 20, 0)).toEqual({ entries: [], total: 0 });
  });
});
