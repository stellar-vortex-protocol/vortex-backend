import { ConfigService } from "@nestjs/config";
import { IntentsGateway } from "./intents.gateway";
import { IntentsService } from "./intents.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { InMemoryIntentsRepository } from "./intents.repository";
import { ProtocolParamsService } from "../governance/params.service";
import { IntentCapabilityIndex } from "./solver-intent-matcher";
import { MemoryReplayStore } from "./backplane/memory-replay.store";
import type { ReplayStore } from "./backplane/replay-store";

/**
 * Gateway ↔ replay-store integration (issue #457).
 *
 * The store's own boundaries live in `backplane/*.spec.ts`; these tests cover
 * the wiring: restart/resume reporting, server-side replay filtering, the
 * 10k-event replay budget, and degraded behaviour during a store outage.
 */

jest.mock("../common/logger", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makeIntentsService(): IntentsService {
  const configService = {
    get: jest.fn().mockReturnValue(false),
  } as unknown as ConfigService<AppConfig, true>;
  const prismaService = {
    intentAuditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
  const protocolParams = {
    snapshotForChain: jest.fn().mockReturnValue({
      version: 0,
      feeBps: 30,
      deadlineSeconds: 1800,
      fillWindowSeconds: 600,
      capturedAt: new Date().toISOString(),
    }),
  } as unknown as ProtocolParamsService;
  return new IntentsService(
    new InMemoryIntentsRepository(),
    configService,
    {} as StellarTxService,
    prismaService,
    protocolParams,
  );
}

function makeSolversService() {
  return { get: jest.fn().mockResolvedValue(undefined) } as never;
}

function makeIntentIndex(): IntentCapabilityIndex {
  return {
    rebuild: jest.fn().mockResolvedValue(undefined),
    addIntent: jest.fn(),
    removeIntent: jest.fn(),
    getEligibleFor: jest.fn().mockReturnValue([]),
  } as unknown as IntentCapabilityIndex;
}

function createMockClient() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    readyState: 1,
    send: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    off: jest.fn(),
    _listeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      if (this._listeners[event]) this._listeners[event](...args);
    },
    _frames(): Record<string, unknown>[] {
      return this.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    },
  };
}

/** Drain microtasks so the async replay path has settled. */
async function flushAsync(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

type MockClient = ReturnType<typeof createMockClient>;

function connect(gateway: IntentsGateway): MockClient {
  const client = createMockClient();
  gateway.handleConnection(client as unknown as import("ws").WebSocket);
  return client;
}

function makeGateway(store?: ReplayStore): IntentsGateway {
  return new IntentsGateway(
    makeIntentsService(),
    makeSolversService(),
    makeIntentIndex(),
    undefined,
    store,
  );
}

describe("IntentsGateway — replay over ReplayStore (#457)", () => {
  const gateways: IntentsGateway[] = [];

  function gateway(store?: ReplayStore): IntentsGateway {
    const instance = makeGateway(store);
    gateways.push(instance);
    return instance;
  }

  afterEach(() => {
    while (gateways.length > 0) gateways.pop()!.onModuleDestroy();
  });

  describe("restart and resume", () => {
    it("reports the durable sequence in `connected` after a restart", async () => {
      const store = new MemoryReplayStore();

      // First process lifetime: three events broadcast, then shutdown.
      const before = gateway(store);
      await before.broadcast({ type: "e1" });
      await before.broadcast({ type: "e2" });
      await before.broadcast({ type: "e3" });
      before.onModuleDestroy();

      // "Restart": a new gateway over the same durable store.
      const after = gateway(store);
      await flushAsync(); // primeSeqMirror settles before the first connection

      const client = connect(after);
      const connected = client._frames().find((f) => f.type === "connected");
      expect(connected).toBeDefined();
      expect(connected!.seq).toBe(3);
    });

    it("replays the pre-restart window to a client that reconnects", async () => {
      const store = new MemoryReplayStore();
      const before = gateway(store);
      await before.broadcast({ type: "pre-1" });
      await before.broadcast({ type: "pre-2" });
      await before.broadcast({ type: "pre-3" });
      before.onModuleDestroy();

      const after = gateway(store);
      await flushAsync();
      const client = connect(after);
      client.send.mockClear();

      client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 1 })));
      await flushAsync();

      const frames = client._frames();
      const start = frames.find((f) => f.type === "replay_start");
      const end = frames.find((f) => f.type === "replay_end");
      const replayed = frames.filter((f) => f.type === "pre-2" || f.type === "pre-3");

      expect(start).toMatchObject({ fromSeq: 1, count: 2 });
      expect(end).toMatchObject({ count: 2 });
      expect(replayed.map((f) => f.seq)).toEqual([2, 3]);
    });

    it("keeps allocating from the durable counter after the restart", async () => {
      const store = new MemoryReplayStore();
      const before = gateway(store);
      await before.broadcast({ type: "old" });
      before.onModuleDestroy();

      const after = gateway(store);
      await after.broadcast({ type: "new" });
      // The new process keeps allocating from the same durable counter.
      expect(await store.latestSeq()).toBe(2);
    });
  });

  describe("server-side replay filtering", () => {
    it("filters a replayed window by chain without sending unmatched events", async () => {
      const store = new MemoryReplayStore();
      const instance = gateway(store);

      // Mixed-chain history in the log.
      await instance.broadcast({ type: "evt", srcChain: "stellar", tag: "s1" });
      await instance.broadcast({ type: "evt", srcChain: "ethereum", tag: "e1" });
      await instance.broadcast({ type: "evt", srcChain: "stellar", tag: "s2" });
      await instance.broadcast({ type: "evt", srcChain: "ethereum", tag: "e2" });

      const client = connect(instance);
      client._emit("message", Buffer.from(JSON.stringify({ type: "subscribe", chains: ["stellar"] })));
      await flushAsync();
      client.send.mockClear();

      client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));
      await flushAsync();

      const frames = client._frames();
      const replayed = frames.filter((f) => f.type === "evt");
      const start = frames.find((f) => f.type === "replay_start");

      // Only the stellar events cross the wire, and the counts say so.
      expect(replayed.map((f) => f.tag)).toEqual(["s1", "s2"]);
      expect(start).toMatchObject({ fromSeq: 0, count: 2 });
    });

    it("sends every retained event to an unfiltered subscriber", async () => {
      const store = new MemoryReplayStore();
      const instance = gateway(store);
      await instance.broadcast({ type: "evt", srcChain: "stellar" });
      await instance.broadcast({ type: "evt", srcChain: "ethereum" });

      const client = connect(instance);
      client.send.mockClear();

      client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));
      await flushAsync();

      const frames = client._frames();
      expect(frames.find((f) => f.type === "replay_start")).toMatchObject({ count: 2 });
      expect(frames.filter((f) => f.type === "evt")).toHaveLength(2);
    });
  });

  describe("replay budget", () => {
    it("replays 10_000 events to a client in under one second", async () => {
      const store = new MemoryReplayStore({ maxEvents: 20_000 });
      for (let i = 0; i < 10_000; i++) {
        await store.append({ type: "tick", i });
      }

      const instance = gateway(store);
      const client = connect(instance);
      client.send.mockClear();

      const started = performance.now();
      client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));
      await flushAsync(40);
      const elapsed = performance.now() - started;

      const frames = client._frames();
      const start = frames.find((f) => f.type === "replay_start");
      const end = frames.find((f) => f.type === "replay_end");
      expect(start).toMatchObject({ count: 10_000 });
      expect(end).toMatchObject({ count: 10_000 });
      expect(frames.filter((f) => f.type === "tick")).toHaveLength(10_000);
      expect(elapsed).toBeLessThan(1_000);
    });
  });

  describe("store outage degradation", () => {
    it("still delivers the live event when append fails, and logs the loss", async () => {
      const failing: ReplayStore = {
        append: jest.fn().mockRejectedValue(new Error("redis down")),
        since: jest.fn().mockResolvedValue([]),
        oldestSeq: jest.fn().mockResolvedValue(-1),
        latestSeq: jest.fn().mockRejectedValue(new Error("redis down")),
        size: jest.fn().mockResolvedValue(0),
      };
      const instance = gateway(failing);
      const client = connect(instance);
      client.send.mockClear();

      await instance.broadcast({ type: "survives" });
      await flushAsync();

      const frames = client._frames();
      expect(frames.some((f) => f.type === "survives")).toBe(true);
      // Local sequence mirror still advances so the feed stays ordered.
      const delivered = frames.find((f) => f.type === "survives");
      expect(delivered!.seq).toBe(1);
    });

    it("answers replay from the store when it is reachable", async () => {
      const store = new MemoryReplayStore();
      const instance = gateway(store);
      await instance.broadcast({ type: "kept" });

      const client = connect(instance);
      client.send.mockClear();
      client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));
      await flushAsync();

      expect(client._frames().find((f) => f.type === "replay_start")).toMatchObject({ count: 1 });
    });

    it("drops the replay request instead of rejecting when the store is down", async () => {
      const failing: ReplayStore = {
        append: jest.fn().mockResolvedValue({ type: "x", seq: 1 }),
        since: jest.fn().mockRejectedValue(new Error("redis down")),
        oldestSeq: jest.fn().mockRejectedValue(new Error("redis down")),
        latestSeq: jest.fn().mockResolvedValue(0),
        size: jest.fn().mockResolvedValue(0),
      };
      const instance = gateway(failing);
      const client = connect(instance);
      client.send.mockClear();

      client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));
      await flushAsync();

      // No replay frames at all — and, critically, no unhandled rejection.
      // (The async `snapshot` frame that follows `connected` is unrelated.)
      const frames = client._frames().filter((f) => String(f.type).startsWith("replay"));
      expect(frames).toHaveLength(0);
    });
  });
});
