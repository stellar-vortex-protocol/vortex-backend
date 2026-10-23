import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { AnalyticsController } from "../src/analytics/analytics.controller";
import { AnalyticsService } from "../src/analytics/analytics.service";
import { IAnalyticsStore, InMemoryAnalyticsStore } from "../src/analytics/analytics.store";
import { ANALYTICS_STORE } from "../src/analytics/analytics.tokens";
import { ANALYTICS_METRICS, AnalyticsFillEvent } from "../src/analytics/analytics.types";
import { enableApiVersioning } from "../src/common/api-versioning";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";
import { Intent } from "../src/intents/intents.types";

const T = Date.UTC(2026, 0, 1, 10, 15, 0);
const range = { interval: "1h", from: Date.UTC(2026, 0, 1) / 1000, to: Date.UTC(2026, 0, 2) / 1000 };

describe("Analytics token-pair and solver-benchmark (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    const store = app.get<IAnalyticsStore>(ANALYTICS_STORE);
    const base = { timestamp: T, chain: "stellar", dstChain: "stellar", fees: 1n, quotedDstAmount: null };
    await store.ingest([
      { ...base, eventId: "e2e:1", srcToken: "USDC", dstToken: "XLM", solver: "A", volume: 100n, durationMs: 100 },
      { ...base, eventId: "e2e:2", srcToken: "XLM", dstToken: "USDC", solver: "B", volume: 300n, durationMs: 500 },
      { ...base, eventId: "e2e:3", srcToken: "USDC", dstToken: "XLM", solver: "C", volume: 200n, durationMs: 300 },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/analytics/token-pair breaks volume down by exact pair", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/analytics/token-pair").query(range).expect(200);
    expect(res.body).toEqual([
      { start: "2026-01-01T10:00:00.000Z", srcToken: "USDC", dstToken: "XLM", volume: "300", fees: "2" },
      { start: "2026-01-01T10:00:00.000Z", srcToken: "XLM", dstToken: "USDC", volume: "300", fees: "1" },
    ]);
  });

  it("GET /api/v1/analytics/volume honors the solver filter", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/analytics/volume")
      .query({ ...range, solver: "B" })
      .expect(200);
    expect(res.body).toEqual([{ start: "2026-01-01T10:00:00.000Z", volume: "300" }]);
  });

  it("GET /api/v1/analytics/solver-benchmark/:address compares with the median solver", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/analytics/solver-benchmark/A")
      .query(range)
      .expect(200);
    expect(res.body).toEqual([
      {
        start: "2026-01-01T10:00:00.000Z",
        solver: { avgMs: 100, volume: "100", count: 1 },
        protocol: { medianAvgMs: 300, medianVolume: "200", solverCount: 3 },
      },
    ]);
  });

  it("returns solver: null for a solver with no fills in a bucket", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/analytics/solver-benchmark/NOBODY")
      .query(range)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].solver).toBeNull();
  });

  it("still rejects unknown metrics", async () => {
    await request(app.getHttpServer()).get("/api/v1/analytics/nope").query(range).expect(400);
  });
});

const H = (hour: number) => Date.UTC(2026, 0, 1, hour, 0, 0);
const FROM = H(0) / 1000;
const TO = Date.UTC(2026, 0, 2) / 1000;

// Larger than Number.MAX_SAFE_INTEGER so any Number() coercion would show up.
const HUGE = 123456789012345678901234567890n;

function evt(overrides: Partial<AnalyticsFillEvent>): AnalyticsFillEvent {
  return {
    eventId: "fill:x",
    timestamp: H(1),
    chain: "stellar",
    dstChain: "stellar",
    srcToken: "USDC",
    dstToken: "USDC",
    solver: "SOLVER_A",
    volume: 0n,
    fees: 0n,
    durationMs: 1000,
    quotedDstAmount: null,
    ...overrides,
  };
}

const EVENTS = [
  evt({ eventId: "1", timestamp: H(1), solver: "SOLVER_A", volume: HUGE, fees: 7n }),
  evt({ eventId: "2", timestamp: H(1), solver: "SOLVER_B", chain: "ethereum", volume: 500n, fees: 5n }),
  evt({ eventId: "3", timestamp: H(3), solver: "SOLVER_B", srcToken: "XLM", volume: 250n, fees: 2n }),
];

/** Parse simple CSV (no embedded commas in these fixtures). */
function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

describe("Analytics endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const store = new InMemoryAnalyticsStore();
    await store.ingest(EVENTS);

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: ANALYTICS_STORE, useValue: store }, AnalyticsService],
    }).compile();

    app = moduleRef.createNestApplication();
    enableApiVersioning(app);
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe("GET /api/v1/analytics/:metric?format=csv", () => {
    for (const metric of ANALYTICS_METRICS) {
      it(`${metric}: CSV header matches the JSON field names and row counts match`, async () => {
        const json = await http()
          .get(`/api/v1/analytics/${metric}`)
          .query({ interval: "1h", from: FROM, to: TO })
          .expect(200);
        expect(json.headers["content-type"]).toMatch(/application\/json/);
        const rows = json.body as Record<string, unknown>[];
        expect(rows.length).toBeGreaterThan(0);

        const csv = await http()
          .get(`/api/v1/analytics/${metric}`)
          .query({ interval: "1h", from: FROM, to: TO, format: "csv" })
          .expect(200);
        expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
        expect(csv.headers["content-disposition"]).toContain(`analytics-${metric}-1h-`);

        const [header, ...data] = parseCsv(csv.text);
        expect(header).toEqual(Object.keys(rows[0]));
        expect(data).toHaveLength(rows.length);
        data.forEach((cells, i) => {
          expect(cells).toEqual(header.map((name) => String(rows[i][name])));
        });
      });
    }

    it("writes bigint-as-string amounts verbatim (no Number() precision loss)", async () => {
      const res = await http()
        .get("/api/v1/analytics/volume")
        .query({ interval: "1h", from: FROM, to: TO, format: "csv" })
        .expect(200);
      expect(res.text).toContain(`2026-01-01T01:00:00.000Z,${(HUGE + 500n).toString()}`);
    });

    it("honours Accept: text/csv when no format is given", async () => {
      const res = await http()
        .get("/api/v1/analytics/fees")
        .query({ interval: "1h", from: FROM, to: TO })
        .set("Accept", "text/csv")
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.text.split("\n")[0]).toBe("start,fees");
    });

    it("keeps JSON as the default and lets ?format=json override Accept", async () => {
      const res = await http()
        .get("/api/v1/analytics/fees")
        .query({ interval: "1h", from: FROM, to: TO, format: "json" })
        .set("Accept", "text/csv")
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("rejects an unknown format with 400", async () => {
      await http()
        .get("/api/v1/analytics/fees")
        .query({ interval: "1h", from: FROM, to: TO, format: "xlsx" })
        .expect(400);
    });
  });

  describe("POST /api/v1/analytics/query", () => {
    it("returns one row per bucket × group-by combination", async () => {
      const res = await http()
        .post("/api/v1/analytics/query")
        .send({ metric: "fees", interval: "1h", from: FROM, to: TO, groupBy: ["solver", "chain"] })
        .expect(200);
      expect(res.body).toEqual([
        { start: "2026-01-01T01:00:00.000Z", chain: "ethereum", solver: "SOLVER_B", fees: "5" },
        { start: "2026-01-01T01:00:00.000Z", chain: "stellar", solver: "SOLVER_A", fees: "7" },
        { start: "2026-01-01T03:00:00.000Z", chain: "stellar", solver: "SOLVER_B", fees: "2" },
      ]);
    });

    it("matches GET /analytics/volume when groupBy is empty or omitted", async () => {
      const fixed = await http()
        .get("/api/v1/analytics/volume")
        .query({ interval: "1h", from: FROM, to: TO })
        .expect(200);
      for (const body of [{}, { groupBy: [] }]) {
        const res = await http()
          .post("/api/v1/analytics/query")
          .send({ metric: "volume", interval: "1h", from: FROM, to: TO, ...body })
          .expect(200);
        expect(res.body).toEqual(fixed.body);
      }
    });

    it("rejects a crafted groupBy value with 400 instead of passing it to the store", async () => {
      for (const groupBy of [["src_token"], ['chain"; DROP TABLE analytics_fills; --'], ["chain", "chain"]]) {
        await http()
          .post("/api/v1/analytics/query")
          .send({ metric: "volume", from: FROM, to: TO, groupBy })
          .expect(400);
      }
    });

    it("rejects metrics the grouped builder does not support", async () => {
      await http()
        .post("/api/v1/analytics/query")
        .send({ metric: "latency", from: FROM, to: TO })
        .expect(400);
    });
  });
});

/** Issues #593, #594, #596: new metrics and CSV output on GET /api/v1/analytics/:metric. */
describe("AnalyticsController (e2e)", () => {
  let app: INestApplication;
  const from = Date.UTC(2026, 0, 1) / 1000;
  const to = Date.UTC(2026, 0, 2) / 1000;
  const rangeStr = `interval=1h&from=${from}&to=${to}`;

  function filled(id: string, overrides: Partial<Intent>): Intent {
    return {
      intentId: id,
      user: "GANALYTICSE2E",
      srcChain: "ethereum",
      srcToken: {
        address: "0xUSDC",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "ethereum",
      },
      srcAmount: "1000000",
      dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      state: "filled",
      createdAt: from + 3600,
      filledAt: from + 3630,
      deadline: from + 7200,
      fillAmount: "9900",
      feeAmount: "10",
      solver: "GSOLVER_A",
      version: 0,
      srcVerified: true,
      ...overrides,
    } as Intent;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.get(AnalyticsService).backfill([
      // Amounts above 2^53 check that CSV keeps base-unit strings exact.
      filled("e2e-1", {
        quotedDstAmount: "10000",
        fillAmount: "9007199254740993",
      }),
      filled("e2e-2", {
        srcChain: "base",
        quotedDstAmount: "10000",
        fillAmount: "10100",
      }),
      filled("e2e-3", {
        quotedDstAmount: undefined,
        filledAt: from + 7300,
        createdAt: from + 7200,
      }),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it.each([...ANALYTICS_METRICS])(
    "GET %s?format=csv matches the JSON field names and row count",
    async (metric) => {
      const json = await request(server())
        .get(`/api/v1/analytics/${metric}?${rangeStr}`)
        .expect(200);
      const csv = await request(server())
        .get(`/api/v1/analytics/${metric}?${rangeStr}&format=csv`)
        .expect(200);

      expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
      expect(csv.headers["content-disposition"]).toContain(
        `analytics-${metric}-1h-`,
      );

      const points = json.body as Record<string, unknown>[];
      expect(points.length).toBeGreaterThan(0);
      const [header, ...rows] = parseCsv(csv.text);
      expect(header).toEqual(Object.keys(points[0]));
      expect(rows).toHaveLength(points.length);
      rows.forEach((row, i) =>
        expect(row).toEqual(header.map((k) => String(points[i][k]))),
      );
    },
  );

  it("keeps base-unit volumes exact in CSV (no Number() coercion)", async () => {
    const csv = await request(server())
      .get(`/api/v1/analytics/chain-pair?${rangeStr}&format=csv`)
      .expect(200);
    expect(csv.text).toContain("ethereum,stellar,9007199254740993");
  });

  it("returns CSV for Accept: text/csv and JSON by default", async () => {
    const viaAccept = await request(server())
      .get(`/api/v1/analytics/volume?${rangeStr}`)
      .set("Accept", "text/csv")
      .expect(200);
    expect(viaAccept.headers["content-type"]).toMatch(/^text\/csv/);

    const plain = await request(server())
      .get(`/api/v1/analytics/volume?${rangeStr}`)
      .expect(200);
    expect(plain.headers["content-type"]).toMatch(/^application\/json/);
    expect(Array.isArray(plain.body)).toBe(true);
  });

  it("chain-pair reports corridors and honours srcChain/dstChain", async () => {
    const all = await request(server())
      .get(`/api/v1/analytics/chain-pair?${rangeStr}`)
      .expect(200);
    expect(all.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          srcChain: "base",
          dstChain: "stellar",
          volume: "10100",
        }),
        expect.objectContaining({ srcChain: "ethereum", dstChain: "stellar" }),
      ]),
    );

    const base = await request(server())
      .get(
        `/api/v1/analytics/chain-pair?${rangeStr}&srcChain=base&dstChain=stellar`,
      )
      .expect(200);
    expect(base.body).toHaveLength(1);
    expect(base.body[0].srcChain).toBe("base");
  });

  it("slippage excludes fills that had no quote", async () => {
    const res = await request(server())
      .get(`/api/v1/analytics/slippage?interval=1d&from=${from}&to=${to}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ count: 2, excludedCount: 1 });
  });

  it("rejects srcChain/dstChain on metrics other than chain-pair", async () => {
    await request(server())
      .get(`/api/v1/analytics/volume?${rangeStr}&dstChain=stellar`)
      .expect(400);
  });

  it("rejects an unknown format", async () => {
    await request(server())
      .get(`/api/v1/analytics/volume?${rangeStr}&format=xml`)
      .expect(400);
  });
});
