import { ConfigService } from "@nestjs/config";
import { IntentsGateway } from "./intents.gateway";
import { IntentsService } from "./intents.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { InMemoryIntentsRepository } from "./intents.repository";
import { logger } from "../common/logger";
import { ProtocolParamsService } from "../governance/params.service";
import { IntentCapabilityIndex } from "./solver-intent-matcher";
import { WS_CLOSE_UNSUPPORTED_PROTOCOL } from "../ws/ws-protocol";

/**
 * Protocol negotiation + message validation on the live gateway (issue #456).
 *
 * The generic gateway behaviour (filters, replay, heartbeat) stays in
 * `intents.gateway.spec.ts`; this file only covers the two #456 concerns:
 * `Sec-WebSocket-Protocol` negotiation and dev/test schema validation.
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

function makeIntentIndex(): IntentCapabilityIndex {
  return {
    rebuild: jest.fn().mockResolvedValue(undefined),
    addIntent: jest.fn(),
    removeIntent: jest.fn(),
    getEligibleFor: jest.fn().mockReturnValue([]),
  } as unknown as IntentCapabilityIndex;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSolversService(): any {
  return { get: jest.fn().mockResolvedValue(null) };
}

function createMockClient() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    readyState: 1, // WebSocket.OPEN
    send: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    off: jest.fn(),
    _listeners: listeners,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _emit(event: string, ...args: unknown[]) {
      if (this._listeners[event]) this._listeners[event](...args);
    },
  };
}

type MockClient = ReturnType<typeof createMockClient>;
const asSocket = (client: MockClient) => client as unknown as import("ws").WebSocket;
const requestWithProtocols = (protocols?: string) =>
  ({ headers: protocols === undefined ? {} : { "sec-websocket-protocol": protocols } }) as
    import("node:http").IncomingMessage;

describe("IntentsGateway protocol negotiation (#456)", () => {
  let gateway: IntentsGateway;

  beforeEach(() => {
    jest.clearAllMocks();
    gateway = new IntentsGateway(makeIntentsService(), makeSolversService(), makeIntentIndex());
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  it("accepts a client offering vortex.v1 and echoes it in the connected frame", () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client), requestWithProtocols("vortex.v1"));

    expect(client.close).not.toHaveBeenCalled();
    const first = JSON.parse(client.send.mock.calls[0][0] as string);
    expect(first.type).toBe("connected");
    expect(first.protocol).toBe("vortex.v1");
    expect(gateway.getSubscriberCount()).toBe(1);
  });

  it("defaults to vortex.v1 when the client sends no subprotocol header", () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client), requestWithProtocols(undefined));

    expect(client.close).not.toHaveBeenCalled();
    const first = JSON.parse(client.send.mock.calls[0][0] as string);
    expect(first.protocol).toBe("vortex.v1");
    expect(gateway.getSubscriberCount()).toBe(1);
  });

  it("defaults to vortex.v1 when handleConnection is called without a request", () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client));

    const first = JSON.parse(client.send.mock.calls[0][0] as string);
    expect(first.protocol).toBe("vortex.v1");
  });

  it("closes a client that only offers unknown versions with code 1002", () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client), requestWithProtocols("vortex.v2"));

    expect(client.close).toHaveBeenCalledWith(
      WS_CLOSE_UNSUPPORTED_PROTOCOL,
      expect.stringContaining("unsupported protocol version"),
    );
    expect(client.send).not.toHaveBeenCalled();
    expect(gateway.getSubscriberCount()).toBe(0);
    expect(gateway.getAliveCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unsupported protocol version"),
    );
  });

  it("does not count a rejected connection towards the connection gauge", () => {
    const rejected = createMockClient();
    const accepted = createMockClient();
    gateway.handleConnection(asSocket(rejected), requestWithProtocols("vortex.v2"));
    gateway.handleConnection(asSocket(accepted), requestWithProtocols("vortex.v1"));

    expect(gateway.getSubscriberCount()).toBe(1);
    // handleDisconnect for the rejected socket must not drive the gauge negative.
    gateway.handleDisconnect(asSocket(rejected));
    expect(gateway.getSubscriberCount()).toBe(1);
  });
});

describe("IntentsGateway message validation (#456)", () => {
  let gateway: IntentsGateway;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    gateway = new IntentsGateway(makeIntentsService(), makeSolversService(), makeIntentIndex());
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("warns about an outbound frame that no longer matches its schema", async () => {
    await gateway.broadcast({
      type: "intent_created",
      intent: { intentId: "abc" }, // missing every other required field
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ws broadcast frame failed schema validation"),
    );
  });

  it("still sends the frame — validation is advisory", async () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client));
    // Let the async `connected`-following snapshot land before clearing.
    await new Promise((resolve) => setImmediate(resolve));
    client.send.mockClear();

    await gateway.broadcast({ type: "intent_created", intent: { intentId: "abc" } });

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(client.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("intent_created");
  });

  it("does not warn for frames that match their schema", async () => {
    await gateway.broadcast({ type: "e1" });

    const warnings = (logger.warn as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes("failed schema validation"),
    );
    expect(warnings).toHaveLength(0);
  });

  it("warns about an invalid inbound client message and keeps handling it", async () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client));
    client.send.mockClear();

    // No `fromSeq` → schema-invalid, but the gateway's historic behaviour
    // (ignore it) must be preserved.
    client._emit("message", JSON.stringify({ type: "replay" }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ws invalid client message"),
    );
    const frames = client.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(frames.find((frame: { type: string }) => frame.type === "replay_start")).toBeUndefined();
  });

  it("validates inbound messages without changing well-formed behaviour", async () => {
    const client = createMockClient();
    gateway.handleConnection(asSocket(client));
    client.send.mockClear();

    client._emit("message", JSON.stringify({ type: "subscribe", chains: ["stellar"] }));

    const frames = client.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(frames.find((frame: { type: string }) => frame.type === "subscribed")).toBeDefined();
  });

  it("turns validation off in production", async () => {
    process.env.NODE_ENV = "production";

    await gateway.broadcast({ type: "intent_created", intent: { intentId: "abc" } });

    const warnings = (logger.warn as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes("failed schema validation"),
    );
    expect(warnings).toHaveLength(0);
  });
});
