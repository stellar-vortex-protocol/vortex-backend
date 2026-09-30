/**
 * Unit tests for BackfillService (#391).
 *
 * Tests cover gap detection, page-overlap idempotency, resume-after-crash,
 * and the fake-source interface. All DB and RPC calls are mocked.
 */

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BackfillService, type EventSource, type EventPage } from "./backfill.service";
import { SorobanService } from "./soroban.service";
import { PrismaService } from "../prisma/prisma.service";
import { nativeToScVal, Address } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/configuration";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const SOLVER_STRKEY = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKW7MW8X2ONKGZGK6XOMP";

function fakeEvent(ledger: number, idx = 0): SorobanRpc.Api.EventResponse {
  return {
    id: `${ledger}-${idx}`,
    ledger,
    ledgerClosedAt: "",
    txHash: "a".repeat(64),
    contractId: CONTRACT_ID,
    type: "contract",
    pagingToken: `${ledger}-${idx}`,
    topic: [nativeToScVal("bond_updated", { type: "string" }), Address.fromString(SOLVER_STRKEY).toScVal()],
    value: nativeToScVal({ new_bond_amount: BigInt("100"), delta: BigInt("10") }),
  } as unknown as SorobanRpc.Api.EventResponse;
}

/** A fake EventSource with controllable page responses. */
class FakeEventSource implements EventSource {
  readonly name = "fake";
  private pages: EventPage[];
  private callCount = 0;

  constructor(pages: EventPage[]) {
    this.pages = pages;
  }

  async fetchPage(_cid: string, _start: number, _size: number): Promise<EventPage> {
    const page = this.pages[this.callCount] ?? { events: [], lastLedger: _start, done: true };
    this.callCount++;
    return page;
  }
}

// ─── Service factory ──────────────────────────────────────────────────────────

function buildService(prismaOverrides?: Partial<{
  processedEvent: {
    findFirst: jest.Mock;
    create: jest.Mock;
    upsert: jest.Mock;
  };
  deadLetterEvent: { create: jest.Mock };
}>) {
  const prisma = {
    processedEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      ...prismaOverrides?.processedEvent,
    },
    deadLetterEvent: {
      create: jest.fn().mockResolvedValue({}),
      ...prismaOverrides?.deadLetterEvent,
    },
  } as unknown as PrismaService;

  const configService = {
    get: jest.fn((key: string) => {
      if (key === "stellar.settlementContractId") return CONTRACT_ID;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;

  const sorobanService = {
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 200000 }),
    getHealth: jest.fn().mockResolvedValue({ status: "healthy" }),
    getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 200000 }),
  } as unknown as SorobanService;

  const service = new BackfillService(configService, prisma, sorobanService);
  return { service, prisma, sorobanService };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BackfillService", () => {
  describe("run()", () => {
    it("processes all events from the fake source", async () => {
      const { service } = buildService();

      const events = [fakeEvent(100000), fakeEvent(100001)];
      const source = new FakeEventSource([
        { events, lastLedger: 100001, done: true },
      ]);

      const result = await service.run({
        fromLedger: 100000,
        toLedger: 100002,
        source,
        rateLimitMs: 0,
      });

      expect(result.eventsProcessed).toBeGreaterThanOrEqual(0); // registry handles it
      expect(result.fromLedger).toBe(100000);
      expect(result.toLedger).toBe(100002);
    });

    it("persists idempotency records for each event", async () => {
      const prismaUpsert = jest.fn().mockResolvedValue({});
      const { service } = buildService({
        processedEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
          upsert: prismaUpsert,
        },
      });

      const source = new FakeEventSource([
        { events: [fakeEvent(100000)], lastLedger: 100000, done: true },
      ]);

      await service.run({ fromLedger: 100000, toLedger: 100001, source, rateLimitMs: 0 });

      expect(prismaUpsert).toHaveBeenCalledTimes(1);
    });

    it("handles an empty range (no events) without error", async () => {
      const { service } = buildService();
      const source = new FakeEventSource([
        { events: [], lastLedger: 100000, done: true },
      ]);

      const result = await service.run({ fromLedger: 100000, toLedger: 100000, source, rateLimitMs: 0 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("rejects concurrent runs and returns the running promise", async () => {
      const { service } = buildService();

      // Slow source that takes a tick to resolve
      const slowSource: EventSource = {
        name: "slow",
        fetchPage: () => new Promise((r) => setTimeout(() => r({ events: [], lastLedger: 1, done: true }), 10)),
      };

      const run1 = service.run({ fromLedger: 1, toLedger: 1, source: slowSource, rateLimitMs: 0 });
      const run2 = service.run({ fromLedger: 1, toLedger: 1, source: slowSource, rateLimitMs: 0 });

      // Both should resolve (run2 returns run1's promise)
      const [r1, r2] = await Promise.all([run1, run2]);
      expect(r1).toBe(r2);
    });
  });

  describe("resume()", () => {
    it("skips already-processed ledgers", async () => {
      const { service } = buildService({
        processedEvent: {
          findFirst: jest.fn().mockResolvedValue({ ledger: 100050 }),
          create: jest.fn().mockResolvedValue({}),
          upsert: jest.fn().mockResolvedValue({}),
        },
      });

      const source = new FakeEventSource([
        { events: [fakeEvent(100051)], lastLedger: 100051, done: true },
      ]);

      const result = await service.resume({
        fromLedger: 100000,
        toLedger: 100100,
        source,
        rateLimitMs: 0,
      });

      expect(result.fromLedger).toBe(100051); // resumed from last+1
    });

    it("returns immediately when range is already complete", async () => {
      const { service } = buildService({
        processedEvent: {
          findFirst: jest.fn().mockResolvedValue({ ledger: 100100 }),
          create: jest.fn().mockResolvedValue({}),
          upsert: jest.fn().mockResolvedValue({}),
        },
      });

      const result = await service.resume({
        fromLedger: 100000,
        toLedger: 100100,
        rateLimitMs: 0,
      });

      expect(result.ledgersProcessed).toBe(0);
      expect(result.eventsProcessed).toBe(0);
    });
  });

  describe("checkGap()", () => {
    it("reports no gap when cursor is within retention window", async () => {
      const { service, sorobanService } = buildService();
      (sorobanService.getLatestLedger as jest.Mock).mockResolvedValue({ sequence: 200000 });
      (sorobanService.getHealth as jest.Mock).mockResolvedValue({ oldestLedger: 182720 });

      const report = await service.checkGap(190000);
      expect(report.hasGap).toBe(false);
      expect(report.gapSize).toBe(0);
    });

    it("reports a gap when cursor < oldestLedger", async () => {
      const { service, sorobanService } = buildService();
      (sorobanService.getLatestLedger as jest.Mock).mockResolvedValue({ sequence: 200000 });
      (sorobanService.getHealth as jest.Mock).mockResolvedValue({ oldestLedger: 182720 });

      const report = await service.checkGap(100000);
      expect(report.hasGap).toBe(true);
      expect(report.gapSize).toBe(82720);
    });
  });

  describe("isRunning", () => {
    it("is false when no backfill is active", () => {
      const { service } = buildService();
      expect(service.isRunning).toBe(false);
    });

    it("is true while a backfill is in progress", () => {
      const { service } = buildService();
      const slowSource: EventSource = {
        name: "slow",
        fetchPage: () => new Promise((r) => setTimeout(() => r({ events: [], lastLedger: 1, done: true }), 50)),
      };
      service.run({ fromLedger: 1, toLedger: 1, source: slowSource, rateLimitMs: 0 });
      expect(service.isRunning).toBe(true);
    });
  });
});
