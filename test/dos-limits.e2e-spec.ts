/**
 * DoS / resource-exhaustion test suite (issue #476).
 *
 * Tests every limit added by the issue #476 hardening pass:
 *
 *   1. Body size cap  — POST > 10 KB → 413
 *   2. JSON depth cap — body nesting > 10 deep → 400
 *   3. Batch size cap — POST /batch with > 100 IDs → 400
 *   4. Pagination cap — GET /intents?limit=101 → 400
 *   5. WS subscribe chain-filter cap — chains array > 20 → subscribe_rejected
 *   6. WS subscription-count cap — > 10 subscribe messages → subscribe_rejected
 *
 * For each limit the test covers:
 *  - Just-under (or at) the limit → passes (2xx / subscribed)
 *  - Just-over the limit          → rejected (4xx / subscribe_rejected)
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import WebSocket from "ws";
import { createTestApp } from "./utils/create-test-app";
import {
  BATCH_LOOKUP_MAX_IDS,
  JSON_MAX_DEPTH,
  LIST_MAX_LIMIT,
  WS_MAX_FILTER_CHAINS,
  WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "../src/config/limits.config";

/** Build a nested JSON object `depth` levels deep with a leaf value. */
function buildNestedObject(depth: number, leaf: unknown = "leaf"): unknown {
  if (depth <= 0) return leaf;
  return { a: buildNestedObject(depth - 1, leaf) };
}

/** Wait for a WS message matching a predicate and resolve with parsed data. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForMessage timeout")), timeoutMs);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });

    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Open a WS connection, wait for the initial "connected" + "snapshot" pair,
 *  then return the client.  Rejects if either message does not arrive. */
async function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);

  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => {
      // Drain the initial connected+snapshot before returning.
      let seen = 0;
      const handler = () => {
        seen++;
        if (seen >= 2) {
          ws.removeListener("message", handler);
          resolve();
        }
      };
      ws.on("message", handler);
    });
  });

  return ws;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("DoS / resource-exhaustion limits (issue #476)", () => {
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication["getHttpServer"]>;

  beforeAll(async () => {
    app = await createTestApp();
    // Bind an ephemeral port: the WS sections below read the real port off
    // httpServer.address(), which is null for an initialised-but-not-listening
    // app. Port 0 lets the OS pick, so parallel suites never collide.
    await app.listen(0);
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 1. Body size cap ─────────────────────────────────────────────────────
  describe("1. Body size cap (10 KB)", () => {
    it("rejects a payload > 10 KB with 413", async () => {
      const oversized = {
        srcAmount: "1".padEnd(11 * 1024, "0"), // clearly >10 KB
      };
      await request(httpServer)
        .post("/api/v1/intents")
        .send(oversized)
        .expect(413);
    });

    it("accepts a well-formed payload within 10 KB with 201/400 (not 413)", async () => {
      // A valid-shaped but short body — validation may still 400 it for missing
      // required fields, but it must NOT 413 (body was accepted by the size gate).
      const small = { srcAmount: "1000000" };
      const res = await request(httpServer).post("/api/v1/intents").send(small);
      expect(res.status).not.toBe(413);
    });
  });

  // ── 2. JSON depth cap ─────────────────────────────────────────────────────
  describe(`2. JSON depth cap (max ${JSON_MAX_DEPTH})`, () => {
    it(`rejects a body nested ${JSON_MAX_DEPTH + 1} levels deep with 400`, async () => {
      const tooDeep = buildNestedObject(JSON_MAX_DEPTH + 1);
      await request(httpServer)
        .post("/api/v1/intents")
        .send(tooDeep)
        .expect(400);
    });

    it(`accepts a body nested exactly ${JSON_MAX_DEPTH} levels deep (not 400 from depth check)`, async () => {
      // Build an object exactly at the depth limit — it should pass the depth
      // guard even if it still fails DTO validation.
      const atLimit = buildNestedObject(JSON_MAX_DEPTH);
      const res = await request(httpServer).post("/api/v1/intents").send(atLimit);
      // Must not be 400 due to depth — DTO validation may reject it for other reasons.
      // We specifically check the response body does not mention "nesting depth".
      if (res.status === 400) {
        const body = res.body as { message?: string | string[] };
        const msgs = Array.isArray(body.message)
          ? body.message.join(" ")
          : body.message ?? "";
        expect(msgs).not.toContain("nesting depth");
      }
    });

    it("rejects a body nested 100 levels deep (well over the cap) with 400", async () => {
      const wayTooDeep = buildNestedObject(100);
      const res = await request(httpServer)
        .post("/api/v1/intents")
        .send(wayTooDeep)
        .expect(400);
      expect((res.body as { message?: string }).message).toMatch(/nesting depth/i);
    });
  });

  // ── 3. Batch size cap ────────────────────────────────────────────────────
  describe(`3. Batch size cap (max ${BATCH_LOOKUP_MAX_IDS} IDs)`, () => {
    it(`rejects ${BATCH_LOOKUP_MAX_IDS + 1} IDs with 400`, async () => {
      const oversized = {
        intentIds: Array.from({ length: BATCH_LOOKUP_MAX_IDS + 1 }, (_, i) => `id-${i}`),
      };
      await request(httpServer)
        .post("/api/v1/intents/batch")
        .send(oversized)
        .expect(400);
    });

    it(`accepts exactly ${BATCH_LOOKUP_MAX_IDS} IDs with 200`, async () => {
      const atLimit = {
        intentIds: Array.from({ length: BATCH_LOOKUP_MAX_IDS }, (_, i) => `id-${i}`),
      };
      // 200 expected — none of the IDs exist so the response will be an empty array.
      await request(httpServer)
        .post("/api/v1/intents/batch")
        .send(atLimit)
        .expect(200);
    });

    it("accepts 1 ID with 200", async () => {
      await request(httpServer)
        .post("/api/v1/intents/batch")
        .send({ intentIds: ["does-not-exist"] })
        .expect(200);
    });

    it("rejects a non-array intentIds with 400", async () => {
      await request(httpServer)
        .post("/api/v1/intents/batch")
        .send({ intentIds: "single-string-not-array" })
        .expect(400);
    });
  });

  // ── 4. Pagination limit cap ───────────────────────────────────────────────
  describe(`4. Pagination limit cap (max ${LIST_MAX_LIMIT})`, () => {
    it(`rejects limit=${LIST_MAX_LIMIT + 1} with 400`, async () => {
      await request(httpServer)
        .get("/api/v1/intents")
        .query({ limit: LIST_MAX_LIMIT + 1 })
        .expect(400);
    });

    it(`accepts limit=${LIST_MAX_LIMIT} with 200`, async () => {
      await request(httpServer)
        .get("/api/v1/intents")
        .query({ limit: LIST_MAX_LIMIT })
        .expect(200);
    });

    it("accepts limit=1 with 200", async () => {
      await request(httpServer).get("/api/v1/intents").query({ limit: 1 }).expect(200);
    });

    it("rejects limit=0 with 400", async () => {
      await request(httpServer).get("/api/v1/intents").query({ limit: 0 }).expect(400);
    });
  });

  // ── 5. WS subscribe chain-filter cap ─────────────────────────────────────
  describe(`5. WS subscribe chain-filter cap (max ${WS_MAX_FILTER_CHAINS} chains)`, () => {
    it(`rejects a subscribe message with ${WS_MAX_FILTER_CHAINS + 1} chains`, (done) => {
      const port = (httpServer.address() as { port: number }).port;

      openWs(port).then((ws) => {
        const tooManyChains = Array.from(
          { length: WS_MAX_FILTER_CHAINS + 1 },
          (_, i) => `chain-${i}`,
        );

        ws.send(JSON.stringify({ type: "subscribe", chains: tooManyChains }));

        waitForMessage(ws, (m) => m.type === "subscribe_rejected")
          .then((msg) => {
            expect(msg.reason).toBeDefined();
            ws.close();
            done();
          })
          .catch(done);
      }).catch(done);
    });

    it(`accepts a subscribe message with exactly ${WS_MAX_FILTER_CHAINS} chains`, (done) => {
      const port = (httpServer.address() as { port: number }).port;

      openWs(port).then((ws) => {
        // Fill with the real supported chains (only 7 exist, so pad with repeats
        // to reach exactly WS_MAX_FILTER_CHAINS — they will be validated against
        // SUPPORTED_CHAINS and only valid ones kept, but the message itself should
        // not be rejected at the length gate).
        const chains = Array.from({ length: WS_MAX_FILTER_CHAINS }, (_, i) =>
          i % 2 === 0 ? "stellar" : "ethereum",
        );

        ws.send(JSON.stringify({ type: "subscribe", chains }));

        waitForMessage(ws, (m) => m.type === "subscribed" || m.type === "subscribe_rejected")
          .then((msg) => {
            // Should be "subscribed" (length gate passed), not "subscribe_rejected"
            expect(msg.type).toBe("subscribed");
            ws.close();
            done();
          })
          .catch(done);
      }).catch(done);
    });
  });

  // ── 6. WS subscription-count cap ─────────────────────────────────────────
  describe(`6. WS subscription-count cap (max ${WS_MAX_SUBSCRIPTIONS_PER_CONNECTION} per connection)`, () => {
    it(`rejects the ${WS_MAX_SUBSCRIPTIONS_PER_CONNECTION + 1}th subscribe message`, (done) => {
      const port = (httpServer.address() as { port: number }).port;

      openWs(port).then(async (ws) => {
        // Send exactly WS_MAX_SUBSCRIPTIONS_PER_CONNECTION subscribe messages;
        // all should succeed.
        for (let i = 0; i < WS_MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) {
          ws.send(JSON.stringify({ type: "subscribe", chains: ["stellar"] }));
          await waitForMessage(ws, (m) => m.type === "subscribed" || m.type === "subscribe_rejected");
        }

        // The next one must be rejected.
        ws.send(JSON.stringify({ type: "subscribe", chains: ["stellar"] }));

        waitForMessage(ws, (m) => m.type === "subscribe_rejected")
          .then((msg) => {
            expect(msg.reason).toBeDefined();
            ws.close();
            done();
          })
          .catch(done);
      }).catch(done);
    }, 15_000);
  });
});
