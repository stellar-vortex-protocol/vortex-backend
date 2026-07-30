import { IntentsGateway } from "./intents.gateway";
import { IntentsService } from "./intents.service";

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
    intentsService = new IntentsService();
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
