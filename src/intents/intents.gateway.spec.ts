import { IntentsGateway, EventRingBuffer } from "./intents.gateway";
import { IntentsService } from "./intents.service";
import { WebSocket } from "ws";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockClient(readyState: number = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    send: jest.fn(),
    on: jest.fn(),
  } as unknown as WebSocket;
}

function makeGateway() {
  const intentsService = {
    getByState: jest.fn().mockReturnValue([]),
  } as unknown as IntentsService;
  const gateway = new IntentsGateway(intentsService);
  return { gateway, intentsService };
}

// ── EventRingBuffer ───────────────────────────────────────────────────────────

describe("EventRingBuffer", () => {
  it("returns empty array when empty", () => {
    const buf = new EventRingBuffer(10);
    expect(buf.since(0)).toEqual([]);
  });

  it("reports oldestSeq=-1 and latestSeq=0 when empty", () => {
    const buf = new EventRingBuffer(10);
    expect(buf.oldestSeq()).toBe(-1);
    expect(buf.latestSeq()).toBe(0);
  });

  it("stores and retrieves events in order", () => {
    const buf = new EventRingBuffer(10);
    buf.push({ seq: 1, type: "a" });
    buf.push({ seq: 2, type: "b" });
    buf.push({ seq: 3, type: "c" });

    expect(buf.since(1)).toEqual([{ seq: 2, type: "b" }, { seq: 3, type: "c" }]);
    expect(buf.since(0)).toHaveLength(3);
    expect(buf.since(3)).toHaveLength(0);
  });

  it("evicts oldest entry when capacity is exceeded", () => {
    const buf = new EventRingBuffer(3);
    buf.push({ seq: 1, type: "a" });
    buf.push({ seq: 2, type: "b" });
    buf.push({ seq: 3, type: "c" });
    buf.push({ seq: 4, type: "d" }); // evicts seq=1

    expect(buf.size()).toBe(3);
    expect(buf.oldestSeq()).toBe(2);
    expect(buf.latestSeq()).toBe(4);
  });
});

// ── IntentsGateway – sequencing ───────────────────────────────────────────────

describe("IntentsGateway – event sequencing (#80)", () => {
  it("stamps broadcast events with a monotonic seq starting at 1", () => {
    const { gateway } = makeGateway();
    const client = makeMockClient();
    gateway.handleConnection(client);

    gateway.broadcast({ type: "intent_created", intentId: "a" });
    gateway.broadcast({ type: "intent_created", intentId: "b" });

    const calls = (client.send as jest.Mock).mock.calls.map((c) => JSON.parse(c[0] as string));
    const broadcasts = calls.filter((e) => e.type === "intent_created");

    expect(broadcasts[0].seq).toBe(1);
    expect(broadcasts[1].seq).toBe(2);
  });

  it("seq never decreases across broadcasts", () => {
    const { gateway } = makeGateway();
    const client = makeMockClient();
    gateway.handleConnection(client);

    for (let i = 0; i < 5; i++) {
      gateway.broadcast({ type: "ping" });
    }

    const calls = (client.send as jest.Mock).mock.calls.map((c) => JSON.parse(c[0] as string));
    const pings = calls.filter((e) => e.type === "ping");
    for (let i = 1; i < pings.length; i++) {
      expect(pings[i].seq).toBeGreaterThan(pings[i - 1].seq);
    }
  });

  it("connected message includes seq", () => {
    const { gateway } = makeGateway();
    const client = makeMockClient();
    gateway.handleConnection(client);

    const firstCall = JSON.parse((client.send as jest.Mock).mock.calls[0][0] as string);
    expect(firstCall.type).toBe("connected");
    expect(typeof firstCall.seq).toBe("number");
  });

  it("snapshot message includes seq", () => {
    const { gateway } = makeGateway();
    const client = makeMockClient();
    gateway.handleConnection(client);

    const secondCall = JSON.parse((client.send as jest.Mock).mock.calls[1][0] as string);
    expect(secondCall.type).toBe("snapshot");
    expect(typeof secondCall.seq).toBe("number");
  });

  it("broadcast stores event in replayBuffer", () => {
    const { gateway } = makeGateway();
    gateway.broadcast({ type: "intent_created", intentId: "x" });
    expect(gateway.replayBuffer.size()).toBe(1);
    expect(gateway.replayBuffer.latestSeq()).toBe(1);
  });
});

// ── IntentsGateway – replay ───────────────────────────────────────────────────

describe("IntentsGateway – replay (#80)", () => {
  it("replays missed events since fromSeq", () => {
    const { gateway } = makeGateway();
    gateway.broadcast({ type: "evt", id: "1" });
    gateway.broadcast({ type: "evt", id: "2" });
    gateway.broadcast({ type: "evt", id: "3" });

    const client = makeMockClient();
    gateway.handleReplay({ fromSeq: 1 }, client);

    const messages = (client.send as jest.Mock).mock.calls.map((c) => JSON.parse(c[0] as string));
    const start = messages.find((m) => m.type === "replay_start");
    const end = messages.find((m) => m.type === "replay_end");
    const events = messages.filter((m) => m.type === "evt");

    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(events).toHaveLength(2); // seq 2 and 3
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("sends replay_too_old when fromSeq is before the oldest buffered event", () => {
    // Use a tiny buffer (capacity=2) so old events get evicted quickly
    const { gateway } = makeGateway();
    // Access private replayBuffer through the public property for test setup
    const buf = gateway.replayBuffer;
    buf.push({ seq: 10, type: "a" });
    buf.push({ seq: 11, type: "b" });

    const client = makeMockClient();
    // fromSeq=5 is before oldest=10
    gateway.handleReplay({ fromSeq: 5 }, client);

    const messages = (client.send as jest.Mock).mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(messages[0].type).toBe("replay_too_old");
    expect(messages[0].oldestAvailableSeq).toBe(10);
  });

  it("sends empty replay when fromSeq equals latestSeq (no missed events)", () => {
    const { gateway } = makeGateway();
    gateway.broadcast({ type: "evt" });

    const client = makeMockClient();
    gateway.handleReplay({ fromSeq: 1 }, client);

    const messages = (client.send as jest.Mock).mock.calls.map((c) => JSON.parse(c[0] as string));
    const end = messages.find((m) => m.type === "replay_end");
    expect(end?.count).toBe(0);
  });

  it("does not send to a closed client during replay", () => {
    const { gateway } = makeGateway();
    gateway.broadcast({ type: "evt", id: "1" });
    gateway.broadcast({ type: "evt", id: "2" });

    const closedClient = makeMockClient(WebSocket.CLOSED);
    gateway.handleReplay({ fromSeq: 0 }, closedClient);

    // replay_start and replay_end are sent unconditionally; only the event
    // payloads are guarded by readyState
    const calls = (closedClient.send as jest.Mock).mock.calls.map((c) => JSON.parse(c[0] as string));
    const evtCalls = calls.filter((m) => m.type === "evt");
    expect(evtCalls).toHaveLength(0);
  });
});
