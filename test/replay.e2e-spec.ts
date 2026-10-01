import { INestApplication } from "@nestjs/common";
import request from "supertest";
import WebSocket from "ws";
import { createTestApp } from "./utils/create-test-app";
import { MemoryReplayStore } from "../src/intents/backplane/memory-replay.store";
import { validateServerFrame } from "../src/ws/ws-schemas";

/**
 * Redis-backed / durable replay end-to-end tests (issue #457).
 *
 * The suite runs against the in-process store — the CI e2e shards have no
 * Redis service — but injects it through the same `REPLAY_STORE` provider the
 * gateway uses, so what is proven here is the behaviour the issue asks for:
 *
 * 1. **Restart and resume** — a fresh app over the same durable store reports
 *    the pre-restart sequence and replays the pre-restart window.
 * 2. **Retention boundaries** — the count boundary produces `replay_too_old`
 *    (the documented reset signal), and a request inside the window replays.
 * 3. **Server-side filtering** — a filtered connection never receives
 *    out-of-scope events from the replayed window.
 * 4. **The budget** — 10 000 events replayed to a real client in under 1 s.
 *
 * The `RedisReplayStore` command-level behaviour (XADD/XRANGE/MAXLEN/sweep)
 * is covered by `src/intents/backplane/redis-replay.store.spec.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = Record<string, any>;

const validCreateBody = {
  user: "GE2ETESTUSER1234567",
  srcChain: "ethereum",
  srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "1000000",
  dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 7,
  minDstAmount: "990000",
};

function collect(ws: WebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.on("message", (data) => {
    try {
      frames.push(JSON.parse(data.toString()));
    } catch {
      // Unparseable frames are asserted against elsewhere.
    }
  });
  return frames;
}

function openSocket(port: number): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, ["vortex.v1"]);
  const frames = collect(ws);
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => {
      ws.removeListener("error", reject);
      resolve({ ws, frames });
    });
  });
}

async function waitForFrame(
  frames: Frame[],
  type: string,
  timeoutMs = 5000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find((frame) => frame.type === type);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for "${type}"; saw: ${frames.map((f) => f.type).join(", ") || "(none)"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function portOf(app: INestApplication): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (app.getHttpServer().address() as { port: number }).port;
}

describe("WebSocket replay durability (e2e, #457)", () => {
  describe("restart and resume", () => {
    let store: MemoryReplayStore;
    let firstApp: INestApplication;
    let secondApp: INestApplication;

    beforeEach(async () => {
      store = new MemoryReplayStore();
      firstApp = await createTestApp({ replayStore: store });
      await firstApp.listen(0);
    });

    afterEach(async () => {
      await firstApp?.close();
      await secondApp?.close();
      secondApp = undefined as unknown as INestApplication;
    });

    it("resumes the sequence and replays the pre-restart window after a restart", async () => {
      const firstPort = portOf(firstApp);

      // Live traffic in the first process lifetime.
      const before = await openSocket(firstPort);
      await request(firstApp.getHttpServer())
        .post("/api/v1/intents")
        .send(validCreateBody)
        .expect(201);
      const created = await waitForFrame(before.frames, "intent_created");
      expect(created.seq).toBeGreaterThan(0);
      before.ws.close();

      // "Restart": a brand-new app instance over the same durable store.
      await firstApp.close();
      secondApp = await createTestApp({ replayStore: store });
      await secondApp.listen(0);
      const secondPort = portOf(secondApp);

      const after = await openSocket(secondPort);
      const connected = await waitForFrame(after.frames, "connected");

      // The new process reports where the log actually stands…
      expect(connected.seq).toBe(created.seq);

      // …and replays the events the first process wrote.
      after.ws.send(JSON.stringify({ type: "replay", fromSeq: 0 }));
      const start = await waitForFrame(after.frames, "replay_start");
      expect(start.fromSeq).toBe(0);
      expect(start.count).toBeGreaterThan(0);
      expect(validateServerFrame(start)).toEqual(expect.objectContaining({ ok: true }));

      const end = await waitForFrame(after.frames, "replay_end");
      expect(end.count).toBe(start.count);

      const replayed = after.frames.filter((frame) => frame.type === "intent_created");
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed[0].seq).toBe(created.seq);

      after.ws.close();
    }, 20000);

    it("allocates the next sequence from the durable counter after the restart", async () => {
      const firstPort = portOf(firstApp);
      const before = await openSocket(firstPort);
      await request(firstApp.getHttpServer())
        .post("/api/v1/intents")
        .send(validCreateBody)
        .expect(201);
      const created = await waitForFrame(before.frames, "intent_created");
      before.ws.close();

      await firstApp.close();
      secondApp = await createTestApp({ replayStore: store });
      await secondApp.listen(0);

      const after = await openSocket(portOf(secondApp));
      await request(secondApp.getHttpServer())
        .post("/api/v1/intents")
        .send({ ...validCreateBody, srcAmount: "2000000" })
        .expect(201);
      const second = await waitForFrame(after.frames, "intent_created");

      // No duplicate seq across the restart — the counter is durable.
      expect(second.seq).toBe(created.seq + 1);

      after.ws.close();
    }, 20000);
  });

  describe("retention boundaries", () => {
    let app: INestApplication;
    let store: MemoryReplayStore;

    beforeAll(async () => {
      // Retention of 2 events: the third append evicts the first.
      store = new MemoryReplayStore({ maxEvents: 2 });
      app = await createTestApp({ replayStore: store });
      await app.listen(0);
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns replay_too_old (the reset signal) once the window has moved past fromSeq", async () => {
      const port = portOf(app);
      const { ws, frames } = await openSocket(port);
      await waitForFrame(frames, "connected");
      frames.length = 0;

      // Three intents → three intent_created events; retention 2 evicts seq=1.
      for (const amount of ["1000000", "2000000", "3000000"]) {
        await request(app.getHttpServer())
          .post("/api/v1/intents")
          .send({ ...validCreateBody, srcAmount: amount })
          .expect(201);
      }
      await waitFor(
        () => frames.filter((frame) => frame.type === "intent_created").length === 3,
        "3 intent_created frames",
      );
      expect(await store.oldestSeq()).toBe(2);

      // fromSeq=0 predates the retained window → reset.
      ws.send(JSON.stringify({ type: "replay", fromSeq: 0 }));
      const tooOld = await waitForFrame(frames, "replay_too_old");

      expect(tooOld.fromSeq).toBe(0);
      expect(tooOld.oldestAvailableSeq).toBe(2);
      expect(validateServerFrame(tooOld)).toEqual(expect.objectContaining({ ok: true }));

      ws.close();
    }, 20000);

    it("replays normally for a fromSeq inside the retention window", async () => {
      const port = portOf(app);
      const { ws, frames } = await openSocket(port);
      await waitForFrame(frames, "connected");
      frames.length = 0;

      // oldest=2, so fromSeq=2 (last retained event) must replay cleanly.
      ws.send(JSON.stringify({ type: "replay", fromSeq: 2 }));
      const start = await waitForFrame(frames, "replay_start");
      expect(start.fromSeq).toBe(2);
      expect(validateServerFrame(start)).toEqual(expect.objectContaining({ ok: true }));

      const end = await waitForFrame(frames, "replay_end");
      expect(end.count).toBe(start.count);

      ws.close();
    }, 20000);
  });

  describe("server-side filtering", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp({ replayStore: new MemoryReplayStore({ maxEvents: 100 }) });
      await app.listen(0);
    });

    afterAll(async () => {
      await app.close();
    });

    it("never sends out-of-scope events from a replayed window", async () => {
      const port = portOf(app);
      const { ws, frames } = await openSocket(port);
      await waitForFrame(frames, "connected");
      frames.length = 0;

      // History: two ethereum intents (the only chain that will be filtered in).
      for (const amount of ["4000000", "5000000"]) {
        await request(app.getHttpServer())
          .post("/api/v1/intents")
          .send({ ...validCreateBody, srcAmount: amount })
          .expect(201);
      }
      await waitFor(
        () => frames.filter((frame) => frame.type === "intent_created").length === 2,
        "2 intent_created frames",
      );
      frames.length = 0;

      ws.send(JSON.stringify({ type: "subscribe", chains: ["stellar"] }));
      await waitForFrame(frames, "subscribed");
      frames.length = 0;

      ws.send(JSON.stringify({ type: "replay", fromSeq: 0 }));
      await waitForFrame(frames, "replay_end");

      // The ethereum intents are in the log but must not cross the wire —
      // and the counts reported by replay_start/end reflect what was sent.
      expect(frames.some((frame) => frame.type === "intent_created")).toBe(false);
      const start = frames.find((frame) => frame.type === "replay_start");
      const end = frames.find((frame) => frame.type === "replay_end");
      expect(start.count).toBe(0);
      expect(end.count).toBe(0);

      ws.close();
    }, 20000);
  });

  describe("replay budget", () => {
    let app: INestApplication;
    let store: MemoryReplayStore;

    beforeAll(async () => {
      store = new MemoryReplayStore({ maxEvents: 20_000 });
      app = await createTestApp({ replayStore: store });
      await app.listen(0);

      for (let i = 0; i < 10_000; i++) {
        await store.append({ type: "tick", i });
      }
    });

    afterAll(async () => {
      await app.close();
    });

    it("replays 10_000 events to a connected client in under one second", async () => {
      const port = portOf(app);
      const { ws, frames } = await openSocket(port);
      await waitForFrame(frames, "connected");
      frames.length = 0;

      const started = Date.now();
      ws.send(JSON.stringify({ type: "replay", fromSeq: 0 }));

      const end = await waitForFrame(frames, "replay_end", 10_000);
      const elapsed = Date.now() - started;

      expect(end.count).toBe(10_000);
      expect(frames.filter((frame) => frame.type === "tick")).toHaveLength(10_000);
      expect(elapsed).toBeLessThan(1_000);

      ws.close();
    }, 30000);
  });
});
