import { AnalyticsService } from "./analytics.service";
import { InMemoryAnalyticsStore } from "./analytics.store";
import { Intent } from "../intents/intents.types";

function filledIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "intent-1",
    user: "GUSER1",
    srcChain: "stellar",
    srcToken: { address: "CUSDC", symbol: "USDC", name: "USD Coin", decimals: 7, chain: "stellar" },
    srcAmount: "1000000",
    dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "filled",
    createdAt: 1_000_000,
    deadline: 1_001_800,
    filledAt: 1_000_030,
    fillAmount: "5000000",
    feeAmount: "250",
    solver: "SOLVER_A",
    version: 0,
    srcVerified: true,
    ...overrides,
  };
}

function makeService() {
  const store = new InMemoryAnalyticsStore();
  const service = new AnalyticsService(store);
  return { service, store };
}

describe("AnalyticsService", () => {
  it("recordFill ingests a filled intent and ignores non-filled ones", async () => {
    const { service, store } = makeService();

    const inserted = await service.recordFill(filledIntent());
    const ignored = await service.recordFill(filledIntent({ state: "open", intentId: "intent-2" }));

    expect(inserted).toBe(1);
    expect(ignored).toBe(0);

    const points = await store.queryVolume({
      interval: "1d",
      from: 1_000_000 * 1000,
      to: 1_010_000 * 1000,
    });
    expect(points[0].volume).toBe("5000000");
  });

  it("backfill replays historical fills and is idempotent", async () => {
    const { service } = makeService();
    const intents = [
      filledIntent({ intentId: "a", fillAmount: "100" }),
      filledIntent({ intentId: "b", fillAmount: "200" }),
      filledIntent({ intentId: "c", state: "cancelled", fillAmount: "999" }), // ignored
    ];

    const first = await service.backfill(intents);
    const second = await service.backfill(intents);

    expect(first).toBe(2);
    expect(second).toBe(0);
  });

  it("maps duration from filledAt - createdAt in milliseconds", async () => {
    const { service, store } = makeService();
    await service.recordFill(filledIntent({ createdAt: 1_000_000, filledAt: 1_000_030 }));

    const points = await store.queryLatency({
      interval: "1d",
      from: 1_000_000 * 1000,
      to: 1_010_000 * 1000,
    });
    expect(points[0].avgMs).toBe(30_000);
    expect(points[0].count).toBe(1);
  });
});
