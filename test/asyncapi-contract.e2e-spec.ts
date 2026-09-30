import { INestApplication } from "@nestjs/common";
import request from "supertest";
import WebSocket from "ws";
import Ajv, { ValidateFunction } from "ajv";
import { parse } from "yaml";
import { createTestApp } from "./utils/create-test-app";
import { serverFrameSchemaNames, validateServerFrame } from "../src/ws/ws-schemas";
import { WS_MAX_SUBSCRIPTIONS_PER_CONNECTION } from "../src/config/limits.config";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildWsAuthMessage } from "../src/common/stellar-signature";

/**
 * Contract tests for the WebSocket protocol (issue #456).
 *
 * Everything asserted here comes from the served document: `GET /docs/ws`
 * returns `docs/asyncapi.yaml`, and the very frames captured from a live
 * gateway are validated against that document's JSON Schemas with ajv. If a
 * frame ever stops matching its schema — or a schema disappears — this suite
 * fails, which is what "the emitted messages match the spec" means in CI.
 *
 * The handshake cases cover the versioning rules: `vortex.v1` selected when
 * offered, v1 assumed when nothing is offered, code `1002` for unknown
 * versions.
 */

/** Minimal `fetch` shape — @types/node does not declare the global. */
interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
const fetchText = (url: string): Promise<FetchResponse> =>
  (globalThis as unknown as { fetch: (url: string) => Promise<FetchResponse> }).fetch(url);

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

describe("AsyncAPI + WS protocol contract (e2e)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let httpServer: any;
  let port: number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spec: any;
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map<string, ValidateFunction>();

  /**
   * Validate a captured frame against `components.schemas.<Frame>` of the
   * served document. Fails with ajv's error list so a contract violation is
   * readable rather than a bare `false`.
   */
  function expectFrameMatchesSpec(frame: Frame): void {
    const schemaName = serverFrameSchemaNames[
      frame.type as keyof typeof serverFrameSchemaNames
    ];
    expect(schemaName).toBeDefined();

    let validate = validators.get(schemaName);
    if (!validate) {
      validate = ajv.compile({ ...spec, $ref: `#/components/schemas/${schemaName}` });
      validators.set(schemaName, validate);
    }

    const valid = validate(frame);
    expect({
      type: frame.type,
      schema: schemaName,
      valid,
      errors: valid ? [] : validate.errors,
    }).toEqual({ type: frame.type, schema: schemaName, valid: true, errors: [] });
  }

  /**
   * Open a socket and attach the frame collector **before** waiting for
   * `open`: the server sends `connected` synchronously on upgrade, and `ws`
   * emits buffered frames in the same tick as `open` — a listener attached
   * after an `await` would miss them.
   */
  function openSocket(
    protocols?: string | string[],
  ): Promise<{ ws: WebSocket; frames: Frame[] }> {
    const ws = protocols
      ? new WebSocket(`ws://localhost:${port}/ws`, protocols)
      : new WebSocket(`ws://localhost:${port}/ws`);
    const frames = collect(ws);
    return new Promise((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => {
        ws.removeListener("error", reject);
        resolve({ ws, frames });
      });
    });
  }

  /** Attach a frame collector; every message is parsed and appended. */
  function collect(ws: WebSocket): Frame[] {
    const frames: Frame[] = [];
    ws.on("message", (data) => {
      try {
        frames.push(JSON.parse(data.toString()));
      } catch {
        // Non-JSON frames would fail validation anyway; ignore parse errors.
      }
    });
    return frames;
  }

  /** Poll until `count` frames have arrived (or fail with a helpful message). */
  async function waitForFrames(frames: Frame[], count: number, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${count} frames; saw: ${frames.map((f) => f.type).join(", ") || "(none)"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForFrame(
    frames: Frame[],
    type: string,
    timeoutMs = 4000,
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

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    httpServer = app.getHttpServer();
    port = (httpServer.address() as { port: number }).port;

    const response = await fetchText(`http://localhost:${port}/docs/ws`);
    expect(response.status).toBe(200);
    spec = parse(await response.text());
    validators.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── The document itself ────────────────────────────────────────────────

  it("serves the AsyncAPI document at /docs/ws", async () => {
    const response = await fetchText(`http://localhost:${port}/docs/ws`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/yaml");

    const text = await response.text();
    expect(text).toContain("asyncapi: 3.0.0");
    expect(text).toContain("title: Vortex Intent Stream");
  });

  it("serves exactly the committed docs/asyncapi.yaml", async () => {
    const response = await fetchText(`http://localhost:${port}/docs/ws`);
    const served = await response.text();
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const committed = fs.readFileSync(path.resolve(__dirname, "../docs/asyncapi.yaml"), "utf8");

    expect(served).toBe(committed);
  });

  it("describes the channel, both operations and every message", () => {
    expect(spec.asyncapi).toBe("3.0.0");
    expect(spec.channels.intentStream.address).toBe("/ws");
    expect(spec.operations.sendToClient.action).toBe("send");
    expect(spec.operations.receiveFromClient.action).toBe("receive");
    expect(spec.servers.vortex["x-vortex-subprotocols"]).toEqual(["vortex.v1"]);

    // Every frame type the gateway can emit is documented.
    for (const schemaName of Object.values(serverFrameSchemaNames)) {
      expect(spec.components.schemas[schemaName]).toBeDefined();
    }

    // …and every documented frame is wired to an operation.
    expect(spec.operations.sendToClient.messages.length).toBe(
      Object.keys(serverFrameSchemaNames).length,
    );
    expect(spec.operations.receiveFromClient.messages.length).toBe(3);
  });

  it("documents the replay flow and the protocol errors", () => {
    for (const name of [
      "ReplayStart",
      "ReplayEnd",
      "ReplayTooOld",
      "AuthError",
      "SubscribeRejected",
    ]) {
      expect(spec.components.schemas[name]).toBeDefined();
    }
    expect(spec.info.description).toContain("1002");
  });

  // ── Handshake / subprotocol negotiation ────────────────────────────────

  it("selects vortex.v1 when the client offers it", async () => {
    const { ws, frames } = await openSocket(["vortex.v1"]);
    await waitForFrames(frames, 2);

    expect(ws.protocol).toBe("vortex.v1");
    expect(frames[0]).toMatchObject({ type: "connected", protocol: "vortex.v1" });
    expect(frames[1].type).toBe("snapshot");

    expectFrameMatchesSpec(frames[0]);
    expectFrameMatchesSpec(frames[1]);

    ws.close();
  });

  it("defaults to vortex.v1 when the client offers no subprotocol", async () => {
    const { ws, frames } = await openSocket();
    await waitForFrames(frames, 1);

    // The handshake carries no subprotocol…
    expect(ws.protocol).toBe("");
    // …but the server still speaks (and reports) the documented default.
    expect(frames[0]).toMatchObject({ type: "connected", protocol: "vortex.v1" });
    expectFrameMatchesSpec(frames[0]);

    ws.close();
  });

  it("selects vortex.v1 when it is offered alongside unknown versions", async () => {
    const { ws, frames } = await openSocket(["vortex.v9", "vortex.v1"]);
    await waitForFrames(frames, 1);

    expect(ws.protocol).toBe("vortex.v1");
    expect(frames[0].protocol).toBe("vortex.v1");

    ws.close();
  });

  it("closes a client that only offers unknown versions with code 1002", async () => {
    const { ws, frames } = await openSocket(["vortex.v2"]);

    const close = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    expect(close.code).toBe(1002);
    expect(close.reason).toContain("unsupported protocol version");
    expect(frames).toHaveLength(0);
  });

  // ── Frames on the wire ─────────────────────────────────────────────────

  it("emits a subscribed frame that matches its schema", async () => {
    const { ws, frames } = await openSocket(["vortex.v1"]);
    await waitForFrames(frames, 2);

    ws.send(JSON.stringify({ type: "subscribe", chains: ["stellar", "ethereum"] }));
    const subscribed = await waitForFrame(frames, "subscribed");

    expectFrameMatchesSpec(subscribed);
    expect(subscribed.filter.chains).toEqual(["stellar", "ethereum"]);

    ws.close();
  });

  it("emits a subscribe_rejected error frame that matches its schema", async () => {
    const { ws, frames } = await openSocket(["vortex.v1"]);
    await waitForFrames(frames, 2);

    for (let i = 0; i <= WS_MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) {
      ws.send(JSON.stringify({ type: "subscribe", chains: ["stellar"] }));
    }
    const rejected = await waitForFrame(frames, "subscribe_rejected");

    expectFrameMatchesSpec(rejected);
    expect(rejected.reason).toContain("Maximum subscription limit");

    ws.close();
  });

  it("emits an auth_error frame that matches its schema", async () => {
    const { ws, frames } = await openSocket(["vortex.v1"]);
    await waitForFrames(frames, 2);

    const kp = SEED_SOLVER_KEYPAIRS.ALPHA;
    const timestamp = Math.floor(Date.now() / 1000);
    // Deliberately corrupt the signature so auth is rejected.
    void buildWsAuthMessage(kp.publicKey(), timestamp);
    ws.send(
      JSON.stringify({
        type: "auth",
        solver: kp.publicKey(),
        timestamp,
        signature: "bm90LWEtcmVhbC1zaWduYXR1cmU=",
      }),
    );

    const authError = await waitForFrame(frames, "auth_error");
    expectFrameMatchesSpec(authError);

    ws.close();
  });

  it("emits intent_created and replay frames that match their schemas", async () => {
    // Creates a real intent over REST while the full e2e suite runs in
    // parallel — allow more than the 5 s default.
    const { ws, frames } = await openSocket(["vortex.v1"]);
    await waitForFrames(frames, 2);

    await request(httpServer).post("/api/v1/intents").send(validCreateBody).expect(201);

    const created = await waitForFrame(frames, "intent_created");
    expectFrameMatchesSpec(created);
    expect(created.seq).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "replay", fromSeq: 0 }));
    const replayStart = await waitForFrame(frames, "replay_start");
    expectFrameMatchesSpec(replayStart);

    await waitForFrame(frames, "replay_end");
    const replayEnd = frames.find((frame) => frame.type === "replay_end");
    expectFrameMatchesSpec(replayEnd as Frame);

    // Replayed events are the same frames that were broadcast — validate one.
    const replayed = frames.filter(
      (frame, index) => frame.type === "intent_created" && index >= 2,
    );
    expect(replayed.length).toBeGreaterThan(0);
    expectFrameMatchesSpec(replayed[0]);

    ws.close();
  }, 30000);

  it("describes replay_too_old with a schema a real frame satisfies", async () => {
    // This frame is only emitted when retention has already dropped the
    // requested window, which a fresh test process cannot reach, so assert a
    // representative frame against the committed schema instead of racing
    // retention to reproduce it live.
    const schema = spec.components.schemas.ReplayTooOld;
    expect(schema).toBeDefined();
    expect(schema.required).toEqual(["type", "fromSeq", "oldestAvailableSeq"]);

    const frame = {
      type: "replay_too_old",
      fromSeq: 100,
      oldestAvailableSeq: 500,
    };
    expectFrameMatchesSpec(frame);
    expect(validateServerFrame(frame as never)).toEqual(expect.objectContaining({ ok: true }));
  });
});
