import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { MetricsRegistry } from "../common/metrics";
import { Intent } from "./intents.types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "test-id",
    user: "GTEST",
    srcChain: "ethereum",
    srcToken: { address: "0x0", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: Math.floor(Date.now() / 1000) - 60,
    deadline: Math.floor(Date.now() / 1000) - 1, // already expired
    ...overrides,
  };
}

function makeSweeperWithMocks(intents: Intent[]) {
  const intentsService = {
    getByState: jest.fn().mockReturnValue(intents),
    update: jest.fn().mockImplementation((_id: string, patch: Partial<Intent>) => patch),
  } as unknown as IntentsService;

  const intentsGateway = {
    broadcast: jest.fn(),
  } as unknown as IntentsGateway;

  const sweeper = new IntentsSweeperService(intentsService, intentsGateway);
  return { sweeper, intentsService, intentsGateway };
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset shared metric state between tests
  MetricsRegistry.sweeper.expiredTotal.reset();
  MetricsRegistry.sweeper.sweepDurationMs.reset();
});

describe("IntentsSweeperService – metrics (#96)", () => {
  it("records a sweep duration observation after every sweep()", () => {
    const { sweeper } = makeSweeperWithMocks([]);

    sweeper.sweep();

    const snap = MetricsRegistry.sweeper.sweepDurationMs.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.sum).toBeGreaterThanOrEqual(0);
  });

  it("increments expiredTotal by the number of expired intents", () => {
    const expired = [makeIntent({ intentId: "a" }), makeIntent({ intentId: "b" })];
    const { sweeper } = makeSweeperWithMocks(expired);

    sweeper.sweep();

    expect(MetricsRegistry.sweeper.expiredTotal.get()).toBe(2);
  });

  it("does not increment expiredTotal when no intents expire", () => {
    const future = makeIntent({ deadline: Math.floor(Date.now() / 1000) + 9999 });
    const { sweeper } = makeSweeperWithMocks([future]);

    sweeper.sweep();

    expect(MetricsRegistry.sweeper.expiredTotal.get()).toBe(0);
  });

  it("accumulates expiredTotal across multiple sweeps", () => {
    const makeExpired = (id: string) => makeIntent({ intentId: id });
    const { sweeper, intentsService } = makeSweeperWithMocks([makeExpired("x")]);

    sweeper.sweep();
    // second sweep produces one more expired intent
    (intentsService.getByState as jest.Mock).mockReturnValue([makeExpired("y")]);
    sweeper.sweep();

    expect(MetricsRegistry.sweeper.expiredTotal.get()).toBe(2);
  });

  it("records multiple duration observations — count matches sweep calls", () => {
    const { sweeper } = makeSweeperWithMocks([]);

    sweeper.sweep();
    sweeper.sweep();
    sweeper.sweep();

    expect(MetricsRegistry.sweeper.sweepDurationMs.snapshot().count).toBe(3);
  });

  it("broadcasts intent_expired for each expired intent", () => {
    const intents = [makeIntent({ intentId: "a" }), makeIntent({ intentId: "b" })];
    const { sweeper, intentsGateway } = makeSweeperWithMocks(intents);

    sweeper.sweep();

    expect(intentsGateway.broadcast).toHaveBeenCalledTimes(2);
    expect(intentsGateway.broadcast).toHaveBeenCalledWith({
      type: "intent_expired",
      intentId: "a",
    });
    expect(intentsGateway.broadcast).toHaveBeenCalledWith({
      type: "intent_expired",
      intentId: "b",
    });
  });
});
