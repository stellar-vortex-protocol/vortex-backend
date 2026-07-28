import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { Intent } from "./intents.types";

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "test-id",
    user: "GUSER",
    srcChain: "ethereum",
    srcToken: {
      address: "0xabc",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      chain: "ethereum",
    },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: Math.floor(Date.now() / 1000) - 300,
    deadline: Math.floor(Date.now() / 1000) + 1800,
    ...overrides,
  };
}

describe("IntentsSweeperService", () => {
  let sweeper: IntentsSweeperService;
  let intentsService: jest.Mocked<IntentsService>;
  let intentsGateway: jest.Mocked<IntentsGateway>;

  beforeEach(() => {
    intentsService = {
      getByState: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<IntentsService>;

    intentsGateway = {
      broadcast: jest.fn(),
    } as unknown as jest.Mocked<IntentsGateway>;

    sweeper = new IntentsSweeperService(intentsService, intentsGateway);
  });

  afterEach(() => {
    jest.useRealTimers();
    sweeper.onModuleDestroy();
  });

  describe("sweep()", () => {
    it("flips an expired open intent to expired state and broadcasts the event", () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = makeIntent({
        intentId: "expired-1",
        deadline: now - 1, // past deadline
      });
      intentsService.getByState.mockReturnValue([expired]);
      intentsService.update.mockReturnValue({ ...expired, state: "expired" });

      // invoke private sweep via onModuleInit with fakeTimers
      jest.useFakeTimers();
      sweeper.onModuleInit();
      jest.runOnlyPendingTimers(); // fires the setInterval callback once

      expect(intentsService.getByState).toHaveBeenCalledWith("open");
      expect(intentsService.update).toHaveBeenCalledWith("expired-1", { state: "expired" });
      expect(intentsGateway.broadcast).toHaveBeenCalledWith({
        type: "intent_expired",
        intentId: "expired-1",
      });
    });

    it("does NOT flip an intent whose deadline is in the future", () => {
      const now = Math.floor(Date.now() / 1000);
      const fresh = makeIntent({
        intentId: "fresh-1",
        deadline: now + 3600,
      });
      intentsService.getByState.mockReturnValue([fresh]);

      jest.useFakeTimers();
      sweeper.onModuleInit();
      jest.runOnlyPendingTimers();

      expect(intentsService.update).not.toHaveBeenCalled();
      expect(intentsGateway.broadcast).not.toHaveBeenCalled();
    });

    it("handles an intent whose deadline equals now (exact boundary → expired)", () => {
      const now = Math.floor(Date.now() / 1000);
      const boundaryIntent = makeIntent({
        intentId: "boundary-1",
        deadline: now, // deadline === now => expired (deadline <= now)
      });
      intentsService.getByState.mockReturnValue([boundaryIntent]);
      intentsService.update.mockReturnValue({ ...boundaryIntent, state: "expired" });

      jest.useFakeTimers();
      sweeper.onModuleInit();
      jest.runOnlyPendingTimers();

      expect(intentsService.update).toHaveBeenCalledWith("boundary-1", { state: "expired" });
      expect(intentsGateway.broadcast).toHaveBeenCalledWith({
        type: "intent_expired",
        intentId: "boundary-1",
      });
    });

    it("processes multiple intents and only expires the ones past their deadline", () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredA = makeIntent({ intentId: "exp-a", deadline: now - 100 });
      const expiredB = makeIntent({ intentId: "exp-b", deadline: now - 1 });
      const freshC = makeIntent({ intentId: "fresh-c", deadline: now + 9999 });
      intentsService.getByState.mockReturnValue([expiredA, expiredB, freshC]);
      intentsService.update.mockImplementation((id, patch) => makeIntent({ intentId: id, ...patch }));

      jest.useFakeTimers();
      sweeper.onModuleInit();
      jest.runOnlyPendingTimers();

      expect(intentsService.update).toHaveBeenCalledTimes(2);
      expect(intentsService.update).toHaveBeenCalledWith("exp-a", { state: "expired" });
      expect(intentsService.update).toHaveBeenCalledWith("exp-b", { state: "expired" });
      expect(intentsService.update).not.toHaveBeenCalledWith("fresh-c", expect.anything());

      expect(intentsGateway.broadcast).toHaveBeenCalledTimes(2);
      expect(intentsGateway.broadcast).toHaveBeenCalledWith({ type: "intent_expired", intentId: "exp-a" });
      expect(intentsGateway.broadcast).toHaveBeenCalledWith({ type: "intent_expired", intentId: "exp-b" });
    });

    it("does nothing when there are no open intents", () => {
      intentsService.getByState.mockReturnValue([]);

      jest.useFakeTimers();
      sweeper.onModuleInit();
      jest.runOnlyPendingTimers();

      expect(intentsService.update).not.toHaveBeenCalled();
      expect(intentsGateway.broadcast).not.toHaveBeenCalled();
    });

    it("broadcasts once per expired intent, not a single batch broadcast", () => {
      const now = Math.floor(Date.now() / 1000);
      const intents = ["a", "b", "c"].map((id) =>
        makeIntent({ intentId: id, deadline: now - 1 }),
      );
      intentsService.getByState.mockReturnValue(intents);
      intentsService.update.mockImplementation((id, patch) => makeIntent({ intentId: id, ...patch }));

      jest.useFakeTimers();
      sweeper.onModuleInit();
      jest.runOnlyPendingTimers();

      expect(intentsGateway.broadcast).toHaveBeenCalledTimes(3);
    });
  });

  describe("onModuleDestroy()", () => {
    it("clears the interval so no further sweeps run", () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, "clearInterval");

      sweeper.onModuleInit();
      sweeper.onModuleDestroy();

      expect(clearSpy).toHaveBeenCalledTimes(1);

      // no further sweep calls after destroy
      intentsService.getByState.mockReturnValue([]);
      jest.advanceTimersByTime(60_000);
      expect(intentsService.getByState).not.toHaveBeenCalled();
    });

    it("is safe to call when onModuleInit was never called (no interval set)", () => {
      // should not throw
      expect(() => sweeper.onModuleDestroy()).not.toThrow();
    });
  });
});
