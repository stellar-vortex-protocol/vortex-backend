import type { IntentsService } from "../intents.service";
import type { SolversService } from "../../solvers/solvers.service";
import { IntentCapabilityIndex } from "../solver-intent-matcher";
import { IntentFeedService } from "./intent-feed.service";
import type { FeedClient, FeedFilter } from "./feed.types";
import type { MemoryBackplane } from "../backplane/memory.backplane";

/** A FeedClient that records everything sent to it. */
class RecordingClient implements FeedClient {
  readonly received: string[] = [];
  closed = false;

  constructor(
    readonly id: string,
    readonly ip = "10.0.0.1",
    /** When set, `send` returns false to simulate an overflowing buffer. */
    private readonly refuse = false,
  ) {}

  send(payload: string): boolean {
    if (this.refuse) return false;
    this.received.push(payload);
    return true;
  }

  close(): void {
    this.closed = true;
  }

  /** Parsed JSON of everything received, in order. */
  get events(): Record<string, unknown>[] {
    return this.received.map((p) => JSON.parse(p) as Record<string, unknown>);
  }

  get types(): string[] {
    return this.events.map((e) => e.type as string);
  }
}

/** A filter with no restrictions — the unfiltered full feed. */
const UNFILTERED: FeedFilter = {
  chains: null,
  solver: null,
  wantAll: false,
  users: null,
  states: null,
  subscriptionCount: 0,
};

function filter(overrides: Partial<FeedFilter>): FeedFilter {
  return { ...UNFILTERED, ...overrides };
}

function makeFeed(overrides: { backplane?: MemoryBackplane; maxConnections?: number } = {}) {
  const intentsService = { get: jest.fn(async () => null) } as unknown as IntentsService;
  const solversService = { get: jest.fn(async () => null) } as unknown as SolversService;
  const intentIndex = {
    addIntent: jest.fn(),
    removeIntent: jest.fn(),
    getEligibleFor: jest.fn(() => []),
  } as unknown as IntentCapabilityIndex;
  const config = {
    get: (key: string) => {
      if (key === "wsMaxConnections") return overrides.maxConnections ?? 1000;
      if (key === "ws") return { maxConnectionsPerIp: 0, trustProxyHops: 0 };
      return undefined;
    },
  } as unknown as ConstructorParameters<typeof IntentFeedService>[4];
  const feed = new IntentFeedService(
    intentsService,
    solversService,
    intentIndex,
    undefined,
    config,
    overrides.backplane,
  );
  return { feed, intentsService, solversService, intentIndex };
}

/** An intent_created event body the feed can filter on. */
function createdIntent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "i1",
    user: "GUSER1",
    srcChain: "stellar",
    srcToken: { symbol: "USDC" },
    dstToken: { symbol: "USDT" },
    state: "open",
    ...overrides,
  };
}

describe("IntentFeedService (#433)", () => {
  describe("sequencing", () => {
    it("assigns strictly increasing sequence numbers", async () => {
      const { feed } = makeFeed();
      await feed.broadcast({ type: "intent_created", intent: createdIntent() });
      await feed.broadcast({ type: "intent_accepted", intentId: "i1" });
      await feed.broadcast({ type: "intent_filled", intentId: "i1" });

      expect(feed.currentSeq).toBe(3);
    });

    it("delivers events to a client in sequence order", async () => {
      const { feed } = makeFeed();
      const client = new RecordingClient("c1");
      feed.addClient(client, UNFILTERED);

      await feed.broadcast({ type: "intent_created", intent: createdIntent() });
      await feed.broadcast({ type: "intent_accepted", intentId: "i1" });
      await feed.broadcast({ type: "intent_filled", intentId: "i1" });

      expect(client.types).toEqual(["intent_created", "intent_accepted", "intent_filled"]);
      expect(client.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("preserves order even when the chain lookup is slow", async () => {
      // Delivery is serialised precisely so an async intentsService.get() that
      // resolves out of order cannot reorder a client's feed. Here the FIRST
      // lookup stalls while the second resolves immediately: without the
      // serialisation the second event would overtake the first.
      let calls = 0;
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const intentsService = {
        get: jest.fn(async () => {
          calls += 1;
          if (calls === 1) await gate;
          return null;
        }),
      } as unknown as IntentsService;
      const feed = new IntentFeedService(
        intentsService,
        { get: jest.fn(async () => null) } as unknown as SolversService,
        { addIntent: jest.fn(), removeIntent: jest.fn() } as unknown as IntentCapabilityIndex,
      );
      const client = new RecordingClient("c1");
      feed.addClient(client, UNFILTERED);

      const first = feed.broadcast({ type: "intent_accepted", intentId: "i1" });
      const second = feed.broadcast({ type: "intent_filled", intentId: "i1" });
      // Let the first lookup finish only after the second was queued behind it.
      await new Promise((r) => setImmediate(r));
      releaseFirst();
      await Promise.all([first, second]);

      expect(client.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(client.types).toEqual(["intent_accepted", "intent_filled"]);
    });
  });

  describe("replay", () => {
    it("replays everything newer than the requested sequence", async () => {
      const { feed } = makeFeed();
      for (let i = 1; i <= 5; i++) {
        await feed.broadcast({ type: "intent_created", intent: createdIntent({ intentId: `i${i}` }) });
      }
      const client = new RecordingClient("c1");

      const result = feed.replaySince(2, client);

      expect(result.tooOld).toBe(false);
      expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    });

    it("returns nothing when the client is already up to date", async () => {
      const { feed } = makeFeed();
      await feed.broadcast({ type: "intent_created", intent: createdIntent() });
      const client = new RecordingClient("c1");

      const result = feed.replaySince(1, client);

      expect(result.events).toEqual([]);
      expect(result.tooOld).toBe(false);
    });

    it("replays the whole buffer when asked from sequence 0", async () => {
      const { feed } = makeFeed();
      await feed.broadcast({ type: "intent_created", intent: createdIntent() });
      await feed.broadcast({ type: "intent_created", intent: createdIntent() });
      const client = new RecordingClient("c1");

      expect(feed.replaySince(0, client).events.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("reports tooOld when the requested sequence has fallen out of the buffer", async () => {
      const { feed } = makeFeed();
      feed.setRingBufferCapacity(3);
      for (let i = 1; i <= 6; i++) {
        await feed.broadcast({ type: "intent_created", intent: createdIntent({ intentId: `i${i}` }) });
      }
      const client = new RecordingClient("c1");

      // The buffer holds seq 4-6, so a resume from 1 cannot be honoured.
      const result = feed.replaySince(1, client);

      expect(result.tooOld).toBe(true);
      expect(result.events).toEqual([]);
      expect(result.oldestSeq).toBe(4);
    });

    it("still replays from the oldest retained sequence", async () => {
      const { feed } = makeFeed();
      feed.setRingBufferCapacity(3);
      for (let i = 1; i <= 6; i++) {
        await feed.broadcast({ type: "intent_created", intent: createdIntent({ intentId: `i${i}` }) });
      }
      const client = new RecordingClient("c1");

      // Resuming from exactly oldestSeq-1 is contiguous, so it is not "too old".
      const result = feed.replaySince(3, client);

      expect(result.tooOld).toBe(false);
      expect(result.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    });

    it("is not tooOld on an empty buffer", async () => {
      const { feed } = makeFeed();
      const result = feed.replaySince(0, new RecordingClient("c1"));
      expect(result.tooOld).toBe(false);
      expect(result.events).toEqual([]);
    });
  });

  describe("filtering", () => {
    it("delivers the full feed to an unfiltered client", async () => {
      const { feed } = makeFeed();
      const client = new RecordingClient("c1");
      feed.addClient(client, UNFILTERED);

      await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "ethereum" }) });

      expect(client.received).toHaveLength(1);
    });

    it("honours wantAll over every other filter", async () => {
      const { feed } = makeFeed();
      const client = new RecordingClient("c1");
      feed.addClient(client, filter({ wantAll: true, states: new Set(["filled" as never]), users: new Set() }));

      await feed.broadcast({ type: "intent_created", intent: createdIntent() });

      expect(client.received).toHaveLength(1);
    });

    describe("chain filter", () => {
      it("delivers only events on a subscribed chain", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ chains: new Set(["stellar" as never]) }));

        await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "stellar" }) });

        expect(client.received).toHaveLength(1);
      });

      it("drops events on a chain the client did not subscribe to", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ chains: new Set(["stellar" as never]) }));

        await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "ethereum" }) });

        expect(client.received).toHaveLength(0);
      });

      it("delivers an event whose chain cannot be determined", async () => {
        // Dropping a chain-less event would silently hide activity; delivering it
        // can only over-notify, which is the safe direction.
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ chains: new Set(["stellar" as never]) }));

        await feed.broadcast({ type: "intent_accepted", intentId: "unknown" });

        expect(client.received).toHaveLength(1);
      });
    });

    describe("user filter", () => {
      it("delivers only the subscribed user's events", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ users: new Set(["GUSER1"]) }));

        await feed.broadcast({ type: "intent_accepted", intentId: "i1", user: "GUSER1" });
        await feed.broadcast({ type: "intent_accepted", intentId: "i2", user: "GUSER2" });

        expect(client.received).toHaveLength(1);
      });

      it("drops an event with no user field", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ users: new Set(["GUSER1"]) }));

        await feed.broadcast({ type: "intent_filled", intentId: "i1" });

        expect(client.received).toHaveLength(0);
      });
    });

    describe("state filter", () => {
      it("delivers only events in a subscribed state", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ states: new Set(["open" as never]) }));

        // The filter reads `state` off the event envelope, not off the inlined
        // intent body, so the envelope has to carry it.
        await feed.broadcast({ type: "intent_created", intent: createdIntent(), state: "open" });
        await feed.broadcast({ type: "intent_filled", intentId: "i1", state: "filled" });

        expect(client.received).toHaveLength(1);
      });

      it("drops an event with no state field", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ states: new Set(["open" as never]) }));

        await feed.broadcast({ type: "heartbeat" });

        expect(client.received).toHaveLength(0);
      });
    });

    describe("solver capability filter", () => {
      const predicate = (matches: boolean, address = "GSOLVER1") => ({
        solverAddress: address,
        matches: () => matches,
      });

      it("delivers an inlined intent the solver can match", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ solver: predicate(true) as never }));

        await feed.broadcast({ type: "intent_created", intent: createdIntent() });

        expect(client.received).toHaveLength(1);
      });

      it("drops an inlined intent the solver cannot match", async () => {
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ solver: predicate(false) as never }));

        await feed.broadcast({ type: "intent_created", intent: createdIntent() });

        expect(client.received).toHaveLength(0);
      });

      it("delivers a non-creation event without consulting the predicate", async () => {
        // Only intent_created carries the intent body; a lifecycle event has
        // nothing to match on, so filtering it out would lose the notification.
        const { feed } = makeFeed();
        const client = new RecordingClient("c1");
        feed.addClient(client, filter({ solver: predicate(false) as never }));

        await feed.broadcast({ type: "intent_cancelled", intentId: "i1" });

        expect(client.received).toHaveLength(1);
      });
    });

    it("applies filters per client, not per broadcast", async () => {
      const { feed } = makeFeed();
      const open = new RecordingClient("open");
      const eth = new RecordingClient("eth");
      feed.addClient(open, UNFILTERED);
      feed.addClient(eth, filter({ chains: new Set(["ethereum" as never]) }));

      await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "stellar" }) });

      expect(open.received).toHaveLength(1);
      expect(eth.received).toHaveLength(0);
    });

    it("applies an updated filter to subsequent events only", async () => {
      const { feed } = makeFeed();
      const client = new RecordingClient("c1");
      feed.addClient(client, UNFILTERED);

      await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "stellar" }) });
      feed.updateClientFilter(client, filter({ chains: new Set(["ethereum" as never]) }));
      await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "stellar" }) });
      await feed.broadcast({ type: "intent_created", intent: createdIntent({ srcChain: "ethereum" }) });

      // Delivered before the filter change, then only the ethereum event after.
      expect(client.received).toHaveLength(2);
    });
  });

  describe("connection accounting", () => {
    it("counts admitted clients", () => {
      const { feed } = makeFeed();
      expect(feed.connectionCount).toBe(0);

      const a = new RecordingClient("a");
      const b = new RecordingClient("b", "10.0.0.2");
      feed.addClient(a, UNFILTERED);
      feed.addClient(b, UNFILTERED);
      expect(feed.connectionCount).toBe(2);

      feed.removeClient(a);
      expect(feed.connectionCount).toBe(1);
    });

    it("ignores the removal of a client that was never admitted", () => {
      // Double-disconnect is normal; it must not drive the count negative.
      const { feed } = makeFeed();
      const a = new RecordingClient("a");
      feed.addClient(a, UNFILTERED);

      feed.removeClient(a);
      feed.removeClient(a);

      expect(feed.connectionCount).toBe(0);
    });

    it("frees the per-IP slot when a client disconnects", () => {
      const { feed } = makeFeed();
      const a = new RecordingClient("a", "10.0.0.1");
      const b = new RecordingClient("b", "10.0.0.1");
      feed.addClient(a, UNFILTERED);
      feed.addClient(b, UNFILTERED);

      feed.removeClient(a);

      // The slot is released, so a new connection from the same IP is admitted.
      const c = new RecordingClient("c", "10.0.0.1");
      expect(feed.addClient(c, UNFILTERED).ok).toBe(true);
    });

    it("rejects a connection beyond the global maximum", () => {
      const { feed } = makeFeed({ maxConnections: 2 });
      for (let i = 0; i < 2; i++) {
        expect(feed.addClient(new RecordingClient(`c${i}`, `10.0.0.${i}`), UNFILTERED).ok).toBe(true);
      }

      const rejected = feed.addClient(new RecordingClient("extra", "10.0.0.99"), UNFILTERED);

      expect(rejected.ok).toBe(false);
      expect(rejected.reason).toBe("max_connections");
      expect(feed.connectionCount).toBe(2);
    });

    it("counts a rejected client as never connected", () => {
      const { feed } = makeFeed({ maxConnections: 2 });
      for (let i = 0; i < 2; i++) {
        feed.addClient(new RecordingClient(`c${i}`, `10.0.0.${i}`), UNFILTERED);
      }
      const extra = new RecordingClient("extra", "10.0.0.99");

      feed.addClient(extra, UNFILTERED);
      feed.removeClient(extra);

      // Removing a rejected client must not decrement another client's count.
      expect(feed.connectionCount).toBe(2);
    });
  });

  describe("backpressure", () => {
    it("disconnects a client whose send reports an overflowing buffer", async () => {
      const { feed } = makeFeed();
      const slow = new RecordingClient("slow", "10.0.0.1", true);
      const healthy = new RecordingClient("healthy", "10.0.0.2");
      feed.addClient(slow, UNFILTERED);
      feed.addClient(healthy, UNFILTERED);

      await feed.broadcast({ type: "intent_created", intent: createdIntent() });

      expect(slow.closed).toBe(true);
      expect(feed.connectionCount).toBe(1);
      // The healthy client is unaffected by its neighbour's overflow.
      expect(healthy.received).toHaveLength(1);
    });

    it("does not keep delivering to a disconnected client", async () => {
      const { feed } = makeFeed();
      const slow = new RecordingClient("slow", "10.0.0.1", true);
      feed.addClient(slow, UNFILTERED);

      await feed.broadcast({ type: "intent_created", intent: createdIntent() });
      await feed.broadcast({ type: "intent_created", intent: createdIntent() });

      // Only the first broadcast was attempted; the client was then evicted.
      expect(feed.connectionCount).toBe(0);
    });
  });

  describe("capability index", () => {
    it("adds an intent to the index on creation", async () => {
      const { feed, intentIndex } = makeFeed();
      const intent = createdIntent();
      await feed.broadcast({ type: "intent_created", intent });
      expect(intentIndex.addIntent).toHaveBeenCalledWith(intent);
    });

    it("removes an intent from the index on every terminal state", async () => {
      const { feed, intentIndex } = makeFeed();
      for (const type of ["intent_accepted", "intent_filled", "intent_cancelled", "intent_expired", "intent_slashed"]) {
        await feed.broadcast({ type, intentId: "i1" });
      }
      expect(intentIndex.removeIntent).toHaveBeenCalledTimes(5);
    });

    it("never lets an index failure break the broadcast", async () => {
      const intentsService = { get: jest.fn(async () => null) } as unknown as IntentsService;
      const intentIndex = {
        addIntent: jest.fn(() => {
          throw new Error("index is corrupt");
        }),
        removeIntent: jest.fn(),
      } as unknown as IntentCapabilityIndex;
      const feed = new IntentFeedService(
        intentsService,
        { get: jest.fn(async () => null) } as unknown as SolversService,
        intentIndex,
      );
      const client = new RecordingClient("c1");
      feed.addClient(client, UNFILTERED);

      await feed.broadcast({ type: "intent_created", intent: createdIntent() });

      expect(client.received).toHaveLength(1);
    });
  });

  describe("lifecycle", () => {
    it("closes every client on shutdown", async () => {
      const { feed } = makeFeed();
      const a = new RecordingClient("a");
      const b = new RecordingClient("b", "10.0.0.2");
      feed.addClient(a, UNFILTERED);
      feed.addClient(b, UNFILTERED);

      await feed.onModuleDestroy();

      expect(a.closed).toBe(true);
      expect(b.closed).toBe(true);
      expect(feed.connectionCount).toBe(0);
    });
  });
});
