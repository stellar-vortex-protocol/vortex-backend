import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { InMemoryAnalyticsStore, TimescaleAnalyticsStore } from "./analytics.store";
import {
  AnalyticsFillEvent,
  AnalyticsGroupedQuery,
  GROUP_BY_DIMENSIONS,
  GroupByDimension,
  GroupedMetric,
  normalizeGroupBy,
} from "./analytics.types";
import { AnalyticsGroupedQueryDto } from "./dto/analytics-grouped-query.dto";

const H = (hour: number, minute = 0) => Date.UTC(2026, 0, 1, hour, minute, 0);

function evt(overrides: Partial<AnalyticsFillEvent>): AnalyticsFillEvent {
  return {
    eventId: "fill:x",
    timestamp: H(1),
    chain: "stellar",
    srcToken: "USDC",
    dstToken: "USDC",
    solver: "A",
    volume: 0n,
    fees: 0n,
    durationMs: 0,
    ...overrides,
  };
}

// Two buckets (01:00, 02:00) with a mix of chains, tokens and solvers.
const EVENTS: AnalyticsFillEvent[] = [
  evt({ eventId: "1", timestamp: H(1, 5), chain: "stellar", srcToken: "USDC", solver: "A", volume: 100n, fees: 1n }),
  evt({ eventId: "2", timestamp: H(1, 10), chain: "stellar", srcToken: "XLM", solver: "B", volume: 200n, fees: 2n }),
  evt({ eventId: "3", timestamp: H(1, 20), chain: "ethereum", srcToken: "USDC", solver: "A", volume: 400n, fees: 4n }),
  evt({ eventId: "4", timestamp: H(1, 30), chain: "stellar", srcToken: "USDC", solver: "A", volume: 800n, fees: 8n }),
  evt({ eventId: "5", timestamp: H(2, 0), chain: "ethereum", srcToken: "WETH", solver: "B", volume: 1600n, fees: 16n }),
  // A token filter on "USDC" also matches this one via its destination token.
  evt({ eventId: "6", timestamp: H(2, 15), chain: "stellar", srcToken: "XLM", dstToken: "USDC", solver: "C", volume: 3200n, fees: 32n }),
  // Outside the [from, to) range — must never be counted.
  evt({ eventId: "7", timestamp: Date.UTC(2026, 0, 3), volume: 999_999n, fees: 999n }),
];

const query = (overrides: Partial<AnalyticsGroupedQuery> = {}): AnalyticsGroupedQuery => ({
  metric: "volume",
  interval: "1h",
  from: H(0),
  to: Date.UTC(2026, 0, 2),
  groupBy: [],
  ...overrides,
});

/** Every subset of the allowed dimensions, including the empty one. */
function allSubsets(): GroupByDimension[][] {
  const subsets: GroupByDimension[][] = [];
  for (let mask = 0; mask < 1 << GROUP_BY_DIMENSIONS.length; mask++) {
    subsets.push(GROUP_BY_DIMENSIONS.filter((_, i) => mask & (1 << i)));
  }
  return subsets;
}

/** Brute-force reference: total per (bucket, dims) key. */
function expected(metric: GroupedMetric, dims: GroupByDimension[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const e of EVENTS) {
    if (e.timestamp >= Date.UTC(2026, 0, 2)) continue;
    const bucket = new Date(Math.floor(e.timestamp / 3_600_000) * 3_600_000).toISOString();
    const values = dims.map((d) => (d === "chain" ? e.chain : d === "token" ? e.srcToken : e.solver));
    const key = JSON.stringify([bucket, ...values]);
    out.set(key, (out.get(key) ?? 0n) + (metric === "volume" ? e.volume : e.fees));
  }
  return out;
}

describe("Grouped analytics query (POST /analytics/query)", () => {
  let store: InMemoryAnalyticsStore;

  beforeEach(async () => {
    store = new InMemoryAnalyticsStore();
    await store.ingest(EVENTS);
  });

  describe("InMemoryAnalyticsStore.queryGrouped", () => {
    const metrics: GroupedMetric[] = ["volume", "fees"];
    for (const metric of metrics) {
      for (const dims of allSubsets()) {
        it(`${metric} grouped by [${dims.join(", ")}] matches a brute-force aggregate`, async () => {
          const rows = await store.queryGrouped(query({ metric, groupBy: dims }));
          const want = expected(metric, dims);

          expect(rows).toHaveLength(want.size);
          for (const row of rows) {
            // Only the requested dimensions and the metric are present.
            expect(Object.keys(row).sort()).toEqual(["start", ...dims, metric].sort());
            const key = JSON.stringify([row.start, ...dims.map((d) => row[d])]);
            expect(row[metric]).toBe(want.get(key)?.toString());
          }
        });
      }
    }

    it("degrades to the existing per-bucket aggregate when groupBy is empty", async () => {
      const base = { interval: "1h" as const, from: H(0), to: Date.UTC(2026, 0, 2) };
      expect(await store.queryGrouped(query({ metric: "volume" }))).toEqual(await store.queryVolume(base));
      expect(await store.queryGrouped(query({ metric: "fees" }))).toEqual(await store.queryFees(base));
    });

    it("returns rows ordered by bucket then by each dimension", async () => {
      const rows = await store.queryGrouped(query({ groupBy: ["solver", "chain"] }));
      expect(rows).toEqual([
        { start: "2026-01-01T01:00:00.000Z", chain: "ethereum", solver: "A", volume: "400" },
        { start: "2026-01-01T01:00:00.000Z", chain: "stellar", solver: "A", volume: "900" },
        { start: "2026-01-01T01:00:00.000Z", chain: "stellar", solver: "B", volume: "200" },
        { start: "2026-01-01T02:00:00.000Z", chain: "ethereum", solver: "B", volume: "1600" },
        { start: "2026-01-01T02:00:00.000Z", chain: "stellar", solver: "C", volume: "3200" },
      ]);
    });

    it("applies the chain/token filters before grouping", async () => {
      const rows = await store.queryGrouped(
        query({ metric: "fees", chain: "stellar", token: "USDC", groupBy: ["token"] }),
      );
      expect(rows).toEqual([
        // Events 1 + 4 (src USDC); event 3 is on ethereum so it is filtered out.
        { start: "2026-01-01T01:00:00.000Z", token: "USDC", fees: "9" },
        // Event 2 matches the token filter through its (default) USDC destination.
        { start: "2026-01-01T01:00:00.000Z", token: "XLM", fees: "2" },
        { start: "2026-01-01T02:00:00.000Z", token: "XLM", fees: "32" },
      ]);
    });

    it("rejects a dimension outside the allowlist", async () => {
      await expect(
        store.queryGrouped(query({ groupBy: ["chain; DROP TABLE x" as GroupByDimension] })),
      ).rejects.toThrow(/Unsupported group-by dimension/);
    });
  });

  describe("normalizeGroupBy", () => {
    it("de-duplicates and orders dimensions canonically", () => {
      expect(normalizeGroupBy(["solver", "chain", "solver"])).toEqual(["chain", "solver"]);
      expect(normalizeGroupBy([])).toEqual([]);
    });
  });

  describe("TimescaleAnalyticsStore.queryGrouped (SQL safety)", () => {
    function timescale() {
      const $queryRawUnsafe = jest.fn().mockResolvedValue([
        { bucket: new Date(H(1)), chain: "stellar", token: "USDC", value: "900" },
      ]);
      const prisma = { $queryRawUnsafe } as unknown as PrismaService;
      return { store: new TimescaleAnalyticsStore(prisma), $queryRawUnsafe };
    }

    it("builds GROUP BY from the fixed column allowlist", async () => {
      const { store: ts, $queryRawUnsafe } = timescale();
      const rows = await ts.queryGrouped(query({ groupBy: ["token", "chain"] }));

      const sql = $queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain(`"chain" AS "chain"`);
      expect(sql).toContain(`"src_token" AS "token"`);
      expect(sql).toContain(`sum("volume") AS value`);
      expect(sql).toMatch(/GROUP BY 1, "chain", "src_token" ORDER BY 1, "chain", "src_token"/);
      expect(sql).toContain("FROM analytics_fills_1h");
      expect(rows).toEqual([{ start: "2026-01-01T01:00:00.000Z", chain: "stellar", token: "USDC", volume: "900" }]);
    });

    it("escapes filter values and groups only by bucket for an empty groupBy", async () => {
      const { store: ts, $queryRawUnsafe } = timescale();
      await ts.queryGrouped(query({ metric: "fees", chain: "x' OR '1'='1" }));
      const sql = $queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain(`chain = 'x'' OR ''1''=''1'`);
      expect(sql).toContain(`sum("fees") AS value`);
      expect(sql).toMatch(/GROUP BY 1 ORDER BY 1$/m);
    });

    it("never sends a crafted dimension to the database", async () => {
      const { store: ts, $queryRawUnsafe } = timescale();
      await expect(
        ts.queryGrouped(query({ groupBy: ['chain"; DROP TABLE analytics_fills; --' as GroupByDimension] })),
      ).rejects.toThrow(/Unsupported group-by dimension/);
      expect($queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe("AnalyticsGroupedQueryDto validation", () => {
    const check = (body: Record<string, unknown>) =>
      validate(plainToInstance(AnalyticsGroupedQueryDto, body));

    it("accepts every allowed dimension and an omitted groupBy", async () => {
      expect(await check({ metric: "fees", from: 0, to: 10, groupBy: ["chain", "token", "solver"] })).toHaveLength(0);
      expect(await check({ metric: "volume", from: 0, to: 10 })).toHaveLength(0);
    });

    it("rejects a groupBy value outside the allowlist", async () => {
      const errors = await check({ metric: "volume", from: 0, to: 10, groupBy: ["chain", "src_token"] });
      expect(errors.map((e) => e.property)).toContain("groupBy");
    });

    it("rejects duplicate dimensions, unsupported metrics and non-array groupBy", async () => {
      expect(await check({ metric: "volume", from: 0, to: 10, groupBy: ["chain", "chain"] })).not.toHaveLength(0);
      expect(await check({ metric: "latency", from: 0, to: 10 })).not.toHaveLength(0);
      expect(await check({ metric: "volume", from: 0, to: 10, groupBy: "chain" })).not.toHaveLength(0);
    });
  });
});
