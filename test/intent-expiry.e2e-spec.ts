/**
 * E2E test — intent expiry via IntentsSweeperService
 *
 * Verifies that an intent past its deadline transitions to `expired` and
 * broadcasts the `intent_expired` WS event when sweep() is invoked.
 *
 * Rather than waiting 30 real seconds for the production interval to fire,
 * we retrieve the sweeper directly from the NestJS DI container and call
 * its (private) sweep() method via a cast to bypass TypeScript visibility.
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import WebSocket from "ws";
import { createTestApp } from "./utils/create-test-app";
import { IntentsSweeperService } from "../src/intents/intents-sweeper.service";
import { IntentsService } from "../src/intents/intents.service";

const BASE_INTENT = {
  srcChain: "ethereum",
  srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "500000",
  dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 7,
  minDstAmount: "490000",
};

/** Helper — open a WS client and collect messages until the timeout. */
function collectWsMessages(
  url: string,
  timeoutMs = 500,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve(messages);
    }, timeoutMs);

    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore non-JSON frames */
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("Intent expiry via sweeper (e2e)", () => {
  let app: INestApplication;
  let sweeper: IntentsSweeperService;
  let intentsService: IntentsService;

  beforeAll(async () => {
    app = await createTestApp();
    sweeper = app.get(IntentsSweeperService);
    intentsService = app.get(IntentsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("transitions a past-deadline open intent to expired when sweep() runs", async () => {
    // Create an intent with a deadline 60 seconds in the past
    const pastDeadline = Math.floor(Date.now() / 1000) - 60;
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GEXPIRYE2ETEST12345" })
      .expect(201);
    const { intentId } = createRes.body;
    expect(createRes.body.state).toBe("open");

    // Manually back-date the deadline by patching via IntentsService
    intentsService.update(intentId, { deadline: pastDeadline });

    // Confirm it's still open before sweep
    const beforeSweep = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(beforeSweep.body.state).toBe("open");
    expect(beforeSweep.body.deadline).toBe(pastDeadline);

    // Invoke the sweeper directly (bypasses the 30-second timer)
    (sweeper as unknown as { sweep(): void }).sweep();

    // Confirm the intent is now expired
    const afterSweep = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(afterSweep.body.state).toBe("expired");
  });

  it("does not expire an open intent whose deadline is in the future", async () => {
    const futureDeadline = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GFUTUREE2ETEST12345" })
      .expect(201);
    const { intentId } = createRes.body;

    // Ensure deadline is in the future (it will be by default but be explicit)
    intentsService.update(intentId, { deadline: futureDeadline });

    (sweeper as unknown as { sweep(): void }).sweep();

    const afterSweep = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(afterSweep.body.state).toBe("open");
  });

  it("only expires intents that are open — accepted intents past deadline are left alone", async () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 60;

    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GACCEPTEDE2ETEST123" })
      .expect(201);
    const { intentId } = createRes.body;

    // Accept the intent first
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    // Back-date the deadline
    intentsService.update(intentId, { deadline: pastDeadline });

    (sweeper as unknown as { sweep(): void }).sweep();

    // Sweep only targets open intents — accepted should remain accepted
    const afterSweep = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(afterSweep.body.state).toBe("accepted");
  });

  it("broadcasts an intent_expired WS event when sweep() expires an intent", async () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 60;

    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GWSEXPIRYE2ETEST123" })
      .expect(201);
    const { intentId } = createRes.body;

    intentsService.update(intentId, { deadline: pastDeadline });

    // Connect a WS client before triggering the sweep
    const port: number = app.getHttpServer().address().port;
    const wsUrl = `ws://localhost:${port}/ws`;

    // Collect messages: let the client settle (connected + snapshot) then sweep
    const messagesPromise = collectWsMessages(wsUrl, 600);

    // Small delay to ensure WS handshake completes before sweep fires
    await new Promise((r) => setTimeout(r, 100));
    (sweeper as unknown as { sweep(): void }).sweep();

    const messages = await messagesPromise;

    const expiredEvents = messages.filter(
      (m) => m.type === "intent_expired" && m.intentId === intentId,
    );
    expect(expiredEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("sweeper handles an empty open-intents list without errors", () => {
    // Force all open intents to accepted so getByState('open') returns []
    const open = intentsService.getByState("open");
    for (const intent of open) {
      intentsService.update(intent.intentId, { state: "cancelled" });
    }

    expect(() => {
      (sweeper as unknown as { sweep(): void }).sweep();
    }).not.toThrow();
  });
});
