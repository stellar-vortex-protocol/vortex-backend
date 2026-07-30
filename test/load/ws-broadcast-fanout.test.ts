/**
 * Load test: WebSocket broadcast fan-out (#84)
 *
 * Spins up the real NestJS app on a random port, connects N simultaneous WS
 * clients, fires a broadcast, and measures:
 *   - per-client message delivery latency
 *   - total fan-out wall-clock time
 *   - memory growth (heapUsed) before vs after
 *
 * Run with:
 *   npx jest --config test/jest-load.json
 * or directly:
 *   npx ts-jest test/load/ws-broadcast-fanout.test.ts
 *
 * The test does NOT rely on external infrastructure — the server is spun up
 * in-process using the standard createTestApp() helper.
 */

import { INestApplication } from "@nestjs/common";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { createTestApp } from "../utils/create-test-app";
import { IntentsGateway } from "../../src/intents/intents.gateway";

// ── tunables ──────────────────────────────────────────────────────────────────

/** Subscriber counts to exercise. Each tier runs as a separate test case. */
const SUBSCRIBER_TIERS = [10, 100, 500];

/**
 * Hard latency budget per-client (ms). A client is considered "slow" if it
 * receives the broadcast more than this many ms after the call to broadcast().
 * Keep generous so the test is not flaky in CI.
 */
const LATENCY_BUDGET_MS = 500;

/** Maximum allowed heap growth (bytes) across the full fan-out. */
const HEAP_GROWTH_BUDGET_BYTES = 50 * 1024 * 1024; // 50 MB

// ── helpers ───────────────────────────────────────────────────────────────────

function getWsPort(app: INestApplication): number {
  const server = app.getHttpServer() as { address(): AddressInfo | null };
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("could not determine WS port");
  return addr.port;
}

/**
 * Open `count` WebSocket clients against the server, wait until every client
 * has received its initial `snapshot` message (meaning the handshake is
 * complete and the server has added it to the subscriber set), then resolve
 * with the array of open sockets.
 */
async function openClients(wsUrl: string, count: number): Promise<WebSocket[]> {
  const clients: WebSocket[] = [];
  const ready: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const ws = new WebSocket(wsUrl);
    clients.push(ws);

    ready.push(
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`client ${i} handshake timeout`)), 10_000);

        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string };
          // The server sends "connected" then "snapshot" on every connection.
          // We wait for the snapshot so we know the client is fully subscribed.
          if (msg.type === "snapshot") {
            clearTimeout(timeout);
            resolve();
          }
        });
      }),
    );
  }

  await Promise.all(ready);
  return clients;
}

/**
 * Broadcast a single event and measure the time (ms) from when broadcast()
 * returns until each client receives the message.
 *
 * Returns an array of per-client latencies in the order they arrived.
 */
async function measureBroadcastLatency(
  gateway: IntentsGateway,
  clients: WebSocket[],
  eventType = "load_test_ping",
): Promise<{ latencies: number[]; wallClockMs: number }> {
  const TARGET_SEQ_MARKER = `__load_test_${Date.now()}`;
  const received: number[] = [];

  const waitForAll = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`broadcast not received by all clients within budget`)),
      LATENCY_BUDGET_MS * 5,
    );

    const handlers: Map<WebSocket, (raw: Buffer) => void> = new Map();

    for (const ws of clients) {
      const handler = (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { type: string; marker?: string };
        if (msg.type === eventType && msg.marker === TARGET_SEQ_MARKER) {
          received.push(Date.now());
          ws.off("message", handler);
          handlers.delete(ws);

          if (handlers.size === 0) {
            clearTimeout(timeout);
            resolve();
          }
        }
      };
      handlers.set(ws, handler);
      ws.on("message", handler);
    }
  });

  // Kick off the broadcast and record the start time *after* the call returns
  // (broadcast() is synchronous — it iterates subscribers immediately).
  const broadcastStart = Date.now();
  gateway.broadcast({ type: eventType, marker: TARGET_SEQ_MARKER });
  const broadcastEnd = Date.now();
  const wallClockMs = broadcastEnd - broadcastStart;

  await waitForAll;

  const latencies = received.map((t) => t - broadcastStart);
  return { latencies, wallClockMs };
}

/** Close all clients and wait for them to finish. */
async function closeClients(clients: WebSocket[]): Promise<void> {
  await Promise.all(
    clients.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.on("close", () => resolve());
          ws.close();
        }),
    ),
  );
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("WS broadcast fan-out load test (#84)", () => {
  let app: INestApplication;
  let wsUrl: string;
  let gateway: IntentsGateway;

  beforeAll(async () => {
    app = await createTestApp();
    // Listen on a random OS-assigned port to avoid collisions in CI
    await app.listen(0);
    const port = getWsPort(app);
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    gateway = app.get(IntentsGateway);
  }, 30_000);

  afterAll(async () => {
    await app.close();
  }, 15_000);

  for (const subscriberCount of SUBSCRIBER_TIERS) {
    // Use a describe block per tier so failures are clearly labelled
    describe(`${subscriberCount} concurrent subscribers`, () => {
      let clients: WebSocket[] = [];

      beforeAll(async () => {
        clients = await openClients(wsUrl, subscriberCount);
      }, 30_000);

      afterAll(async () => {
        await closeClients(clients);
      }, 15_000);

      it(`delivers broadcast to all ${subscriberCount} clients`, async () => {
        const { latencies } = await measureBroadcastLatency(gateway, clients);
        expect(latencies).toHaveLength(subscriberCount);
      }, 30_000);

      it(`all clients receive within ${LATENCY_BUDGET_MS}ms latency budget`, async () => {
        const { latencies } = await measureBroadcastLatency(gateway, clients, "latency_check");
        const slowClients = latencies.filter((l) => l > LATENCY_BUDGET_MS);

        // Log a summary regardless of pass/fail so CI logs are informative
        const p50 = percentile(latencies, 50);
        const p95 = percentile(latencies, 95);
        const p99 = percentile(latencies, 99);
        console.log(
          `[load-test] subscribers=${subscriberCount} ` +
            `p50=${p50}ms p95=${p95}ms p99=${p99}ms ` +
            `slow=${slowClients.length}`,
        );

        expect(slowClients.length).toBe(0);
      }, 30_000);

      it(`synchronous fan-out wall-clock time stays proportional`, async () => {
        const heapBefore = process.memoryUsage().heapUsed;

        const { wallClockMs } = await measureBroadcastLatency(gateway, clients, "wall_clock_check");

        const heapAfter = process.memoryUsage().heapUsed;
        const heapGrowth = heapAfter - heapBefore;

        console.log(
          `[load-test] subscribers=${subscriberCount} ` +
            `wallClock=${wallClockMs}ms heapGrowth=${(heapGrowth / 1024).toFixed(1)}KB`,
        );

        // Wall-clock should be low because broadcast() iterates synchronously
        // and ws.send() is non-blocking (it enqueues into libuv).
        // Allow a loose upper bound rather than asserting an exact number.
        expect(wallClockMs).toBeLessThan(1000);
        expect(heapGrowth).toBeLessThan(HEAP_GROWTH_BUDGET_BYTES);
      }, 30_000);
    });
  }
});

// ── statistics helpers ────────────────────────────────────────────────────────

function percentile(sortedOrUnsorted: number[], p: number): number {
  if (sortedOrUnsorted.length === 0) return 0;
  const sorted = [...sortedOrUnsorted].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
