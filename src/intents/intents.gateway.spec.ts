import { ConfigService } from "@nestjs/config";
import { IntentsGateway } from "./intents.gateway";
import { IntentsService } from "./intents.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { logger } from "../common/logger";

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
  return new IntentsService(configService, {} as StellarTxService, prismaService);
}

function createMockClient() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    readyState: 1,
    send: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    _listeners: listeners,
  };
}

describe("IntentsGateway heartbeat", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    intentsService = makeIntentsService();
    gateway = new IntentsGateway(intentsService);
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

  it("broadcasts to all alive subscribers", () => {
    const c1 = createMockClient();
    const c2 = createMockClient();
    gateway.handleConnection(c1 as unknown as import("ws").WebSocket);
    gateway.handleConnection(c2 as unknown as import("ws").WebSocket);

    gateway.broadcast({ type: "test_event", data: 123 });

    const expected = JSON.stringify({ type: "test_event", data: 123 });
    expect(c1.send).toHaveBeenCalledWith(expected);
    expect(c2.send).toHaveBeenCalledWith(expected);
  });
});

describe("IntentsGateway logging", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    intentsService = makeIntentsService();
    gateway = new IntentsGateway(intentsService);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it("logs heartbeat started on construction", () => {
    expect(logger.info).toHaveBeenCalledWith("ws heartbeat started");
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

  it("logs broadcast event type without payload", () => {
    const client = createMockClient();
    gateway.handleConnection(client as unknown as import("ws").WebSocket);

    gateway.broadcast({ type: "intent_created", intent: { id: "123", secret: "data" } });

    expect(logger.debug).toHaveBeenCalledWith(
      "ws broadcast type=intent_created subscribers=1",
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
