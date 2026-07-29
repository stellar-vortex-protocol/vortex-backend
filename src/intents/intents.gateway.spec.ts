import { IntentsGateway } from "./intents.gateway";
import { IntentsService } from "./intents.service";
import { WebSocket } from "ws";

describe("IntentsGateway", () => {
  let gateway: IntentsGateway;
  let intentsService: IntentsService;

  function mockClient(): WebSocket {
    return {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      on: jest.fn(),
    } as unknown as WebSocket;
  }

  beforeEach(() => {
    intentsService = new IntentsService();
    gateway = new IntentsGateway(intentsService);
  });

  describe("handleConnection", () => {
    it("sends a connected message and snapshot on connect", () => {
      const client = mockClient();
      gateway.handleConnection(client);

      const calls = (client.send as jest.Mock).mock.calls;
      expect(calls.length).toBe(2);

      const connectedMsg = JSON.parse(calls[0][0]);
      expect(connectedMsg).toEqual({ type: "connected", message: "Vortex intent stream" });

      const snapshotMsg = JSON.parse(calls[1][0]);
      expect(snapshotMsg.type).toBe("snapshot");
      expect(Array.isArray(snapshotMsg.intents)).toBe(true);
      expect(snapshotMsg.intents.length).toBeLessThanOrEqual(20);
    });

    it("registers error handler that removes client from subscribers", () => {
      const client = mockClient();
      gateway.handleConnection(client);

      const onMock = client.on as jest.Mock;
      const errorHandler = onMock.mock.calls.find(
        ([event]: string[]) => event === "error",
      ) as [string, () => void];
      expect(errorHandler).toBeDefined();

      (client.send as jest.Mock).mockClear();

      errorHandler[1]();
      gateway.broadcast({ type: "test" });

      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe("handleDisconnect", () => {
    it("removes the client from subscribers so broadcast does not send to it", () => {
      const client = mockClient();
      gateway.handleConnection(client);
      (client.send as jest.Mock).mockClear();

      gateway.handleDisconnect(client);
      gateway.broadcast({ type: "test" });

      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcast", () => {
    it("sends event to all OPEN clients", () => {
      const client1 = mockClient();
      const client2 = mockClient();
      gateway.handleConnection(client1);
      gateway.handleConnection(client2);

      (client1.send as jest.Mock).mockClear();
      (client2.send as jest.Mock).mockClear();

      const event = { type: "test", data: 42 };
      gateway.broadcast(event);

      expect(JSON.parse((client1.send as jest.Mock).mock.calls[0][0])).toEqual(event);
      expect(JSON.parse((client2.send as jest.Mock).mock.calls[0][0])).toEqual(event);
    });

    it("skips clients that are not in OPEN state", () => {
      const openClient = mockClient();
      const closedClient = mockClient();
      Object.assign(closedClient, { readyState: WebSocket.CLOSED });

      gateway.handleConnection(openClient);
      gateway.handleConnection(closedClient);

      (openClient.send as jest.Mock).mockClear();
      (closedClient.send as jest.Mock).mockClear();

      gateway.broadcast({ type: "test" });

      expect(openClient.send).toHaveBeenCalledTimes(1);
      expect(closedClient.send).not.toHaveBeenCalled();
    });

    it("sends the JSON-serialized event payload", () => {
      const client = mockClient();
      gateway.handleConnection(client);
      (client.send as jest.Mock).mockClear();

      const event = { type: "intent_created", intent: { id: "abc" } };
      gateway.broadcast(event);

      expect((client.send as jest.Mock).mock.calls[0][0]).toBe(JSON.stringify(event));
    });
  });
});
