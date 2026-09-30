/**
 * E2E test: WebSocket graceful shutdown (Activity 2)
 * 
 * Verifies that:
 * 1. server_draining event is sent to all clients
 * 2. Connections close in batches over drain timeout
 * 3. Readiness flips to not-ready immediately
 * 4. New connections are rejected during drain
 */

import { INestApplication } from "@nestjs/common";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { createTestApp } from "./utils/create-test-app";
import { IntentsGateway } from "../src/intents/intents.gateway";
import * as request from "supertest";

function getWsPort(app: INestApplication): number {
  const server = app.getHttpServer() as { address(): AddressInfo | null };
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("could not determine WS port");
  return addr.port;
}

async function connectClient(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => reject(new Error("connection timeout")), 5000);

    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("WebSocket graceful shutdown (Activity 2)", () => {
  let app: INestApplication;
  let wsUrl: string;
  let gateway: IntentsGateway;

  beforeAll(async () => {
    // Override drain timeout for faster tests
    process.env.WS_DRAIN_TIMEOUT_MS = "2000";
    
    app = await createTestApp();
    await app.listen(0);
    const port = getWsPort(app);
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    gateway = app.get(IntentsGateway);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    delete process.env.WS_DRAIN_TIMEOUT_MS;
  }, 15_000);

  it("should send server_draining event to all clients", async () => {
    const clients: WebSocket[] = [];
    const drainMessages: any[] = [];

    // Connect 3 clients
    for (let i = 0; i < 3; i++) {
      const ws = await connectClient(wsUrl);
      clients.push(ws);

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "server_draining") {
          drainMessages.push(msg);
        }
      });
    }

    // Wait for all clients to receive connected + snapshot
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start draining (simulate SIGTERM)
    const drainPromise = gateway.startDraining();

    // Wait for draining events
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(drainMessages.length).toBe(3);
    
    for (const msg of drainMessages) {
      expect(msg.type).toBe("server_draining");
      expect(msg.resumeFrom).toBeGreaterThanOrEqual(0);
      expect(msg.reconnectAfterMs).toBeGreaterThan(0);
      expect(msg.reason).toBe("graceful_shutdown");
    }

    await drainPromise;

    // All clients should be closed
    for (const ws of clients) {
      expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(ws.readyState);
    }
  }, 10_000);

  it("should reject new connections during drain", async () => {
    // Connect initial clients
    const client1 = await connectClient(wsUrl);
    
    // Start draining
    const drainPromise = gateway.startDraining();

    // Wait a bit for draining flag to be set
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try to connect new client during drain
    const rejectedPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      
      ws.on("close", (code, reason) => {
        if (code === 1001) {
          resolve({ code, reason: reason.toString() });
        } else {
          reject(new Error(`Unexpected close code: ${code}`));
        }
      });

      ws.on("open", () => {
        reject(new Error("Connection should have been rejected"));
      });

      ws.on("error", () => {
        // Expected during drain
      });
    });

    const rejection = await rejectedPromise as { code: number; reason: string };
    expect(rejection.code).toBe(1001);
    expect(rejection.reason).toBe("Server draining");

    await drainPromise;
    client1.close();
  }, 10_000);

  it("should flip readiness to not-ready during drain", async () => {
    // Check readiness before drain
    const beforeDrain = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(200);
    
    expect(beforeDrain.body.ready).toBe(true);

    // Start draining
    const drainPromise = gateway.startDraining();

    // Wait for drain to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check readiness during drain
    const duringDrain = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(503);

    expect(duringDrain.body.ready).toBe(false);

    await drainPromise;
  }, 10_000);

  it("should close connections in batches over drain timeout", async () => {
    const clientCount = 20;
    const clients: WebSocket[] = [];
    const closeTimes: number[] = [];

    // Connect clients
    for (let i = 0; i < clientCount; i++) {
      const ws = await connectClient(wsUrl);
      clients.push(ws);

      ws.on("close", () => {
        closeTimes.push(Date.now());
      });
    }

    // Wait for all connected
    await new Promise(resolve => setTimeout(resolve, 500));

    const drainStart = Date.now();
    await gateway.startDraining();
    const drainEnd = Date.now();

    // Drain should take roughly WS_DRAIN_TIMEOUT_MS (2000ms in tests)
    const drainDuration = drainEnd - drainStart;
    expect(drainDuration).toBeGreaterThan(1500); // Allow some slack
    expect(drainDuration).toBeLessThan(3000);

    // All clients should be closed
    expect(closeTimes.length).toBe(clientCount);

    // Verify batched closure (not all at once)
    const timeSpread = Math.max(...closeTimes) - Math.min(...closeTimes);
    expect(timeSpread).toBeGreaterThan(100); // At least 100ms spread
  }, 15_000);

  it("should include resumeFrom seq in draining event", async () => {
    const ws = await connectClient(wsUrl);
    let drainMessage: any = null;

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "server_draining") {
        drainMessage = msg;
      }
    });

    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 500));

    // Trigger a broadcast to advance seq
    await gateway.broadcast({ type: "test_event", data: "test" });
    await new Promise(resolve => setTimeout(resolve, 100));

    // Start draining
    await gateway.startDraining();

    // Wait for drain message
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(drainMessage).not.toBeNull();
    expect(drainMessage.resumeFrom).toBeGreaterThan(0);
    expect(typeof drainMessage.reconnectAfterMs).toBe("number");

    ws.close();
  }, 10_000);
});
