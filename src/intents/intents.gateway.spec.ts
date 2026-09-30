import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { IntentsGateway, EventRingBuffer } from "./intents.gateway";
import { IntentsService } from "./intents.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { InMemoryIntentsRepository } from "./intents.repository";
import { logger } from "../common/logger";
import { buildWsAuthMessage } from "../common/stellar-signature";
import { ProtocolParamsService } from "../governance/params.service";
import { IntentCapabilityIndex } from "./solver-intent-matcher";
import { SolverRecord } from "../solvers/solvers.types";

/**
 * Full `SolverRecord` stand-in for the WS auth path.
 *
 * The gateway compiles a capability predicate from the record, so a bare
 * `{ address, isActive }` stub would throw on `supportedTokens.map(...)` the
 * moment auth succeeds and take the whole worker down with it.
 */
function makeSolverRecord(address: string, overrides: Partial<SolverRecord> = {}): SolverRecord {
  return {
    address,
    name: "test-solver",
    bondAmount: "1000",
    fillsCompleted: 0,
    fillsFailed: 0,
    totalVolume: "0",
    avgFillTime: 0,
    isActive: true,
    registeredAt: 0,
    lastActiveAt: 0,
    supportedChains: ["ethereum"],
    supportedTokens: ["USDC"],
    ...overrides,
  };
}

/** Stub capability index: the gateway only reads eligible intents from it. */
function makeIntentIndex(): IntentCapabilityIndex {
  return {
    rebuild: jest.fn().mockResolvedValue(undefined),
    addIntent: jest.fn(),
    removeIntent: jest.fn(),
    getEligibleFor: jest.fn().mockReturnValue([]),
  } as unknown as IntentCapabilityIndex;
}
import { IntentFeedService } from "./feed/intent-feed.service";

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
  const repo = new InMemoryIntentsRepository();
  const protocolParams = {
    snapshotForChain: jest.fn().mockReturnValue({ version: 0, feeBps: 30, deadlineSeconds: 1800, fillWindowSeconds: 600, capturedAt: new Date().toISOString() }),
  } as unknown as ProtocolParamsService;
  return new IntentsService(
    repo,
    configService,
    {} as StellarTxService,
    prismaService,
    protocolParams,
  );
}

function makeSolversService() {
  return {
    get: jest.fn().mockResolvedValue(makeSolverRecord("GTEST")),
  } as any;
}

function makeIntentIndex(intentsService: IntentsService): IntentCapabilityIndex {
  return new IntentCapabilityIndex(intentsService);
}

function makeFeed(
  intentsService: IntentsService,
  solversService: ReturnType<typeof makeSolversService>,
  intentIndex: IntentCapabilityIndex,
  ringBufferCapacity?: number,
): IntentFeedService {
  const feed = new IntentFeedService(intentsService, solversService, intentIndex);
  if (ringBufferCapacity !== undefined) feed.setRingBufferCapacity(ringBufferCapacity);
  return feed;
}

function createMockClient() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    // Real `ws` sockets expose OPEN as an instance property (== 1); ConnectionState
    // reads `socket.OPEN`, so the double must mirror that or every send is treated
    // as "not open" and silently dropped.
    OPEN: 1,
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    off: jest.fn(),
    _listeners: listeners,
    // Helper: simulate an incoming message from the client
    _emit: function (event: string, ...args: unknown[]) {
      if (this._listeners[event]) this._listeners[event](...args);
    },
  };
}

// ── EventRingBuffer unit tests ─────────────────────────────────────────────

describe("EventRingBuffer", () => {
  it("returns -1 for oldestSeq when empty", () => {
    const buf = new EventRingBuffer(5);
    expect(buf.oldestSeq()).toBe(-1);
  });

  it("returns 0 for latestSeq when empty", () => {
    const buf = new EventRingBuffer(5);
    expect(buf.latestSeq()).toBe(0);
  });

  it("tracks size", () => {
    const buf = new EventRingBuffer(5);
    buf.push({ seq: 1, type: "a" });
    buf.push({ seq: 2, type: "b" });
    expect(buf.size()).toBe(2);
  });

  it("evicts oldest when at capacity", () => {
    const buf = new EventRingBuffer(3);
    buf.push({ seq: 1, type: "a" });
    buf.push({ seq: 2, type: "b" });
    buf.push({ seq: 3, type: "c" });
    buf.push({ seq: 4, type: "d" }); // evicts seq=1
    expect(buf.oldestSeq()).toBe(2);
    expect(buf.size()).toBe(3);
  });

  it("since returns only events after the given seq", () => {
    const buf = new EventRingBuffer(10);
    for (let i = 1; i <= 5; i++) buf.push({ seq: i, type: "e" });
    const result = buf.since(3);
    expect(result.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("since returns empty array when fromSeq >= latestSeq", () => {
    const buf = new EventRingBuffer(10);
    buf.push({ seq: 1, type: "e" });
    expect(buf.since(1)).toEqual([]);
    expect(buf.since(99)).toEqual([]);
  });

  it("since returns all events when fromSeq < oldestSeq", () => {
    const buf = new EventRingBuffer(3);
    buf.push({ seq: 5, type: "e" });
    buf.push({ seq: 6, type: "e" });
    // fromSeq=1 is older than oldest (5), since() returns events with seq > 1 — all
    const result = buf.since(1);
    expect(result.map((e) => e.seq)).toEqual([5, 6]);
  });
});

// ── IntentsGateway heartbeat tests ────────────────────────────────────────

describe("IntentsGateway heartbeat", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;
  let solversService: ReturnType<typeof makeSolversService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    intentsService = makeIntentsService();
    solversService = makeSolversService();
    gateway = new IntentsGateway(intentsService, solversService, makeIntentIndex());
    const intentIndex = makeIntentIndex(intentsService);
    const feed = makeFeed(intentsService, solversService, intentIndex);
    gateway = new IntentsGateway(intentsService, solversService, intentIndex, feed);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it("marks new connections as alive", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    expect(gateway.getAliveCount()).toBe(1);
  });

  it("removes disconnected clients", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    expect(gateway.getAliveCount()).toBe(1);
    gateway.handleDisconnect(client as unknown as import("ws").WebSocket);
    expect(gateway.getAliveCount()).toBe(0);
  });

  it("terminates clients that do not respond to ping", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    jest.advanceTimersByTime(30_000);

    jest.advanceTimersByTime(30_000);

    expect(client.terminate).toHaveBeenCalled();
    expect(gateway.getAliveCount()).toBe(0);
  });

  it("keeps alive clients that respond with pong", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    jest.advanceTimersByTime(30_000);

    expect(client.ping).toHaveBeenCalled();
    expect(client.terminate).not.toHaveBeenCalled();

    client._listeners.pong();

    expect(gateway.getAliveCount()).toBe(1);

    jest.advanceTimersByTime(30_000);

    expect(client.terminate).not.toHaveBeenCalled();
    expect(gateway.getAliveCount()).toBe(0);

    client._listeners.pong();

    expect(gateway.getAliveCount()).toBe(1);
  });

  it("cleans up interval on module destroy", () => {
    gateway.onModuleDestroy();
    jest.advanceTimersByTime(60_000);
    expect(true).toBe(true);
  });

  it("broadcasts to all alive subscribers (unfiltered)", async () => {
    const c1 = createMockClient();
    const c2 = createMockClient();
    gateway.handleConnection(c1 as unknown as import("ws").WebSocket);
    gateway.handleConnection(c2 as unknown as import("ws").WebSocket);

    // Wait for the async snapshot send to complete before clearing mocks
    await Promise.resolve();

    c1.send.mockClear();
    c2.send.mockClear();

    await gateway.broadcast({ type: "test_event", data: 123 });

    expect(c1.send).toHaveBeenCalledTimes(1);
    expect(c2.send).toHaveBeenCalledTimes(1);
    // Both payloads should contain the event type
    const payload1 = JSON.parse(c1.send.mock.calls[0][0] as string);
    expect(payload1.type).toBe("test_event");
    expect(typeof payload1.seq).toBe("number");
  });

  it("accepts a valid solver auth message and rejects invalid signatures", async () => {
    const keypair = Keypair.random();
    const client = createMockClient();
    const timestamp = Math.floor(Date.now() / 1000);
    solversService.get = jest.fn().mockResolvedValue(makeSolverRecord(keypair.publicKey()));

    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    const message = buildWsAuthMessage(keypair.publicKey(), timestamp);
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    await client._listeners.message(JSON.stringify({ type: "auth", solver: keypair.publicKey(), timestamp, signature }));
    // auth_ok is followed by an eligible_snapshot frame, so assert the frame was
    // sent rather than that it was the final one. ConnectionState passes a flush
    // callback as a second argument, so match on the payload argument only.
    expect(client.send.mock.calls.map((c: unknown[]) => c[0])).toContain(
      JSON.stringify({ type: "auth_ok", method: "signature" }),
    );

    await client._listeners.message(JSON.stringify({ type: "auth", solver: keypair.publicKey(), timestamp, signature: "bad" }));
    expect(client.send.mock.calls.map((c: unknown[]) => c[0])).toContain(
      JSON.stringify({ type: "auth_error", reason: "invalid solver signature" }),
    );
  });
});

// ── IntentsGateway logging tests ──────────────────────────────────────────

describe("IntentsGateway logging", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;
  let solversService: ReturnType<typeof makeSolversService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    intentsService = makeIntentsService();
    solversService = makeSolversService();
    gateway = new IntentsGateway(intentsService, solversService, makeIntentIndex());
    const intentIndex = makeIntentIndex(intentsService);
    const feed = makeFeed(intentsService, solversService, intentIndex);
    gateway = new IntentsGateway(intentsService, solversService, intentIndex, feed);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it("logs heartbeat started on construction", () => {
    // The gateway now logs the backplane mode alongside the heartbeat banner.
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^ws heartbeat started/));
  });

  it("logs connection with subscriber count", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    expect(logger.info).toHaveBeenCalledWith("ws client connected (subscribers=1)");
  });

  it("logs disconnection with subscriber count", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    gateway.handleDisconnect(client as unknown as import("ws").WebSocket);

    expect(logger.info).toHaveBeenCalledWith("ws client disconnected (subscribers=0)");
  });

  it("logs broadcast event type without payload", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    await gateway.broadcast({ type: "intent_created", intent: { id: "123", secret: "data" } });

    // Sequencing/broadcast logging moved to the transport-agnostic feed service
    // (issue #433); the log line must not include the event payload.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringMatching(/feed broadcast type=intent_created/),
    );
  });

  it("logs heartbeat termination of dead client", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    jest.advanceTimersByTime(60_000);

    expect(logger.debug).toHaveBeenCalledWith(
      "ws heartbeat terminated dead client (subscribers=0)",
    );
  });
});

// ── #257: Chain subscription filtering ────────────────────────────────────

describe("IntentsGateway — chain subscription filtering (#257)", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    intentsService = makeIntentsService();
    gateway = new IntentsGateway(intentsService, makeSolversService(), makeIntentIndex());
    const solversService = makeSolversService();
    const intentIndex = makeIntentIndex(intentsService);
    const feed = makeFeed(intentsService, solversService, intentIndex);
    gateway = new IntentsGateway(intentsService, solversService, intentIndex, feed);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it("responds with subscribed message when client sends valid subscribe", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    // Simulate incoming subscribe message
    client._emit("message", Buffer.from(JSON.stringify({ type: "subscribe", chains: ["stellar", "ethereum"] })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const subscribed = calls.find((m) => m.type === "subscribed");
    expect(subscribed).toBeDefined();
    expect(subscribed.filter.chains).toEqual(expect.arrayContaining(["stellar", "ethereum"]));
  });

  it("strips invalid chain values from subscribe message", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    client._emit("message", Buffer.from(JSON.stringify({
      type: "subscribe",
      chains: ["stellar", "invalid_chain", "STELLAR", 123],
    })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const subscribed = calls.find((m) => m.type === "subscribed");
    expect(subscribed).toBeDefined();
    // Only "stellar" survives validation
    expect(subscribed.filter.chains).toEqual(["stellar"]);
  });

  it("ignores subscribe message with missing chains field", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    // Should not crash and should not send subscribed
    client._emit("message", Buffer.from(JSON.stringify({ type: "subscribe" })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const subscribed = calls.find((m) => m.type === "subscribed");
    expect(subscribed).toBeUndefined();
  });

  it("ignores malformed JSON without crashing", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    // Should not throw
    expect(() => {
      client._emit("message", Buffer.from("not valid json{{{"));
    }).not.toThrow();
  });

  it("delivers intent_created only to subscribed chain clients", async () => {
    const stellarClient = createMockClient();
    const ethClient = createMockClient();
    const allClient = createMockClient(); // no subscribe = receives all

    gateway.handleConnection(stellarClient as unknown as import("ws").WebSocket);
    gateway.handleConnection(ethClient as unknown as import("ws").WebSocket);
    gateway.handleConnection(allClient as unknown as import("ws").WebSocket);

    // Subscribe stellar client to stellar only
    stellarClient._emit("message", Buffer.from(JSON.stringify({ type: "subscribe", chains: ["stellar"] })));
    // Subscribe eth client to ethereum only
    ethClient._emit("message", Buffer.from(JSON.stringify({ type: "subscribe", chains: ["ethereum"] })));

    stellarClient.send.mockClear();
    ethClient.send.mockClear();
    allClient.send.mockClear();

    // Broadcast a stellar intent_created
    await gateway.broadcast({
      type: "intent_created",
      intent: { intentId: "abc", srcChain: "stellar", state: "open" },
    });

    // stellarClient and allClient should receive it
    const stellarCalls = stellarClient.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const ethCalls = ethClient.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const allCalls = allClient.send.mock.calls.map((c) => JSON.parse(c[0] as string));

    expect(stellarCalls.some((m) => m.type === "intent_created")).toBe(true);
    expect(ethCalls.some((m) => m.type === "intent_created")).toBe(false); // filtered out
    expect(allCalls.some((m) => m.type === "intent_created")).toBe(true);
  });

  it("delivers intent to all subscribers when chain is not resolvable", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client._emit("message", Buffer.from(JSON.stringify({ type: "subscribe", chains: ["stellar"] })));
    client.send.mockClear();

    // Unknown type with no chain
    await gateway.broadcast({ type: "system_announcement", message: "maintenance" });

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(calls.some((m) => m.type === "system_announcement")).toBe(true);
  });

  it("unfiltered client (no subscribe) receives all events", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    await gateway.broadcast({
      type: "intent_created",
      intent: { intentId: "xyz", srcChain: "ethereum", state: "open" },
    });
    await gateway.broadcast({
      type: "intent_created",
      intent: { intentId: "abc", srcChain: "stellar", state: "open" },
    });

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const created = calls.filter((m) => m.type === "intent_created");
    expect(created).toHaveLength(2);
  });

  it("assigns increasing seq numbers to broadcast events", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    await gateway.broadcast({ type: "e1" });
    await gateway.broadcast({ type: "e2" });
    await gateway.broadcast({ type: "e3" });

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const seqs = calls.map((m: { seq: number }) => m.seq);
    // seq values should be strictly increasing
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

// ── #258: Event replay ────────────────────────────────────────────────────

describe("IntentsGateway — event replay (#258)", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    intentsService = makeIntentsService();
    gateway = new IntentsGateway(intentsService, makeSolversService(), makeIntentIndex());
    const solversService = makeSolversService();
    const intentIndex = makeIntentIndex(intentsService);
    const feed = makeFeed(intentsService, solversService, intentIndex);
    gateway = new IntentsGateway(intentsService, solversService, intentIndex, feed);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it("returns replay_start, replayed events, and replay_end for valid fromSeq", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    // Broadcast 3 events so they land in the ring buffer with seq 1, 2, 3
    await gateway.broadcast({ type: "e1" });
    await gateway.broadcast({ type: "e2" });
    await gateway.broadcast({ type: "e3" });

    client.send.mockClear();

    // Request replay from seq=1 (expect events with seq > 1 → seq 2 and 3)
    client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 1 })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const startMsg = calls.find((m) => m.type === "replay_start");
    const endMsg = calls.find((m) => m.type === "replay_end");
    const events = calls.filter((m) => m.type === "e2" || m.type === "e3");

    expect(startMsg).toBeDefined();
    expect(startMsg.fromSeq).toBe(1);
    expect(startMsg.count).toBe(2);
    expect(events).toHaveLength(2);
    expect(endMsg).toBeDefined();
    expect(endMsg.count).toBe(2);
  });

  it("returns replay_too_old when fromSeq has been evicted from the buffer", async () => {
    // Use a tiny ring buffer (capacity 2) to force eviction
    const tinyGateway = new IntentsGateway(intentsService, makeSolversService(), makeIntentIndex());
    // @ts-expect-error – accessing private field for test setup
    tinyGateway.ringBuffer["capacity"] = 2;
    const solversService = makeSolversService();
    const intentIndex = makeIntentIndex(intentsService);
    const feed = makeFeed(intentsService, solversService, intentIndex, 2);
    const tinyGateway = new IntentsGateway(intentsService, solversService, intentIndex, feed);

    const client = createMockClient();
    tinyGateway.handleConnection(client as unknown as import("ws").WebSocket);

    // Broadcast enough to evict seq=1
    await tinyGateway.broadcast({ type: "e1" }); // seq=1
    await tinyGateway.broadcast({ type: "e2" }); // seq=2
    await tinyGateway.broadcast({ type: "e3" }); // seq=3 — evicts seq=1

    client.send.mockClear();

    // seq=1 is now gone; oldest is seq=2. fromSeq=0 < oldest-1=1 → too_old
    client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const tooOld = calls.find((m) => m.type === "replay_too_old");
    expect(tooOld).toBeDefined();
    expect(tooOld.fromSeq).toBe(0);
    expect(typeof tooOld.oldestAvailableSeq).toBe("number");

    tinyGateway.onModuleDestroy();
  });

  it("returns replay with 0 events when fromSeq equals latest buffered seq", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    await gateway.broadcast({ type: "e1" }); // seq=1
    const lastSeq = 1;

    client.send.mockClear();

    client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: lastSeq })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const startMsg = calls.find((m) => m.type === "replay_start");
    expect(startMsg).toBeDefined();
    expect(startMsg.count).toBe(0);
  });

  it("ignores replay with missing fromSeq", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    client._emit("message", Buffer.from(JSON.stringify({ type: "replay" })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(calls.find((m) => m.type === "replay_start")).toBeUndefined();
    expect(calls.find((m) => m.type === "replay_too_old")).toBeUndefined();
  });

  it("handles replay on an empty buffer (returns replay_start with count 0)", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);
    client.send.mockClear();

    // Buffer is empty — oldestSeq() = -1, so the not-too-old path is taken
    client._emit("message", Buffer.from(JSON.stringify({ type: "replay", fromSeq: 0 })));

    const calls = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const startMsg = calls.find((m) => m.type === "replay_start");
    const endMsg = calls.find((m) => m.type === "replay_end");
    expect(startMsg).toBeDefined();
    expect(startMsg.count).toBe(0);
    expect(endMsg).toBeDefined();
  });

  it("pushes broadcast events into the ring buffer before sending", async () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    await gateway.broadcast({ type: "test_buffered" });

    // The replay buffer now lives in the transport-agnostic feed service
    // (issue #433); the gateway delegates replay to it.
    // @ts-expect-error – accessing private for assertion
    expect(gateway.feed.replaySince(0, null as never).events).toHaveLength(1);
  });
});
