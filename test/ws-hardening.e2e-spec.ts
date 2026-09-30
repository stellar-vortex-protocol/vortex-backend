import { signHs256Jwt } from "../src/common/jwt";
import { connectClient, createWsTestApp, waitFor, WsTestApp } from "./utils/create-ws-test-app";

/** Issue #455 — admission limits, inbound rate limiting, maxPayload, JWT and backpressure. */
describe("WS gateway hardening (e2e)", () => {
  const secret = "x".repeat(32);
  let t: WsTestApp;

  beforeAll(async () => {
    t = await createWsTestApp({
      config: {
        authJwtSecret: secret,
        ws: {
          maxPayloadBytes: 2048,
          maxConnectionsPerIp: 3,
          trustProxyHops: 1,
          rateLimitPerSec: 1,
          rateLimitBurst: 3,
          rateLimitMaxViolations: 3,
          outboundQueueMax: 20,
          outboundBufferBytes: 64 * 1024,
          slowConsumerPolicy: "drop_oldest",
        },
      },
      solvers: { GSOLVER: { address: "GSOLVER", isActive: true } },
    });
  }, 30_000);

  afterAll(() => t.app.close());

  const closed = (ws: import("ws")) =>
    new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );

  it("floods: rate_limited frames, then disconnect with 1008", async () => {
    const { ws, frames } = await connectClient(t.url, { headers: { "x-forwarded-for": "198.51.100.1" } });
    const done = closed(ws);
    for (let i = 0; i < 50; i++) ws.send(JSON.stringify({ type: "subscribe", chains: ["stellar"] }));
    const { code } = await done;
    expect(code).toBe(1008);
    expect(frames.filter((f) => f.type === "rate_limited").length).toBe(2);
    expect(await t.metrics.metrics()).toContain('vortex_ws_rate_limited_total{action="disconnected"} 1');
  });

  it("closes connections sending frames above maxPayload (1009)", async () => {
    const { ws } = await connectClient(t.url, { headers: { "x-forwarded-for": "198.51.100.2" } });
    const done = closed(ws);
    ws.send("y".repeat(4096));
    expect((await done).code).toBe(1009);
  });

  it("limits connections per client IP from the trusted X-Forwarded-For hop", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9, 198.51.100.3" };
    const open = await Promise.all([1, 2, 3].map(() => connectClient(t.url, { headers })));
    const fourth = await connectClient(t.url, { headers });
    const { code } = await closed(fourth.ws);
    expect(code).toBe(1013);
    // A different real client IP behind the same proxy is still admitted.
    const other = await connectClient(t.url, { headers: { "x-forwarded-for": "198.51.100.4" } });
    expect(other.ws.readyState).toBe(other.ws.OPEN);
    for (const c of [...open, other]) c.ws.close();
  });

  it("authenticates a solver JWT on connect; anonymous and bad tokens stay public", async () => {
    const token = signHs256Jwt({ sub: "GSOLVER", exp: Math.floor(Date.now() / 1000) + 60 }, secret);
    const authed = await connectClient(`${t.url}?token=${token}`, { headers: { "x-forwarded-for": "198.51.100.5" } });
    await waitFor(() => authed.frames.some((f) => f.type === "auth_ok"));
    expect(authed.frames.find((f) => f.type === "auth_ok")).toMatchObject({ method: "jwt" });

    const bad = await connectClient(t.url, { headers: { authorization: "Bearer nope", "x-forwarded-for": "198.51.100.6" } });
    await waitFor(() => bad.frames.some((f) => f.type === "auth_error"));
    expect(bad.ws.readyState).toBe(bad.ws.OPEN);

    const anon = await connectClient(t.url, { headers: { "x-forwarded-for": "198.51.100.7" } });
    await t.gateway.broadcast({ type: "tick" });
    await waitFor(() => anon.frames.some((f) => f.type === "tick"));
    for (const c of [authed, bad, anon]) c.ws.close();
  });

  it("keeps memory bounded for a slow consumer (drop-oldest)", async () => {
    const slow = await connectClient(t.url, { headers: { "x-forwarded-for": "198.51.100.8" } });
    const fast = await connectClient(t.url, { headers: { "x-forwarded-for": "198.51.100.9" } });
    // Stop reading: the server's socket buffer fills and backpressure kicks in.
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();

    const blob = "z".repeat(16 * 1024);
    for (let i = 0; i < 400; i++) await t.gateway.broadcast({ type: "big", i, blob });

    const states = (t.gateway as unknown as { connections: Map<unknown, { ip: string; queued(): number }> }).connections;
    const slowState = [...states.values()].find((s) => s.ip === "198.51.100.8")!;
    expect(slowState.queued()).toBeLessThanOrEqual(20);
    const serverSocket = [...states.keys()][[...states.values()].indexOf(slowState)] as { bufferedAmount: number };
    // Bounded by the buffer threshold plus the queue, far below 400 × 16 KiB.
    expect(serverSocket.bufferedAmount).toBeLessThan(64 * 1024 + 21 * (blob.length + 100));
    expect(await t.metrics.metrics()).toMatch(/vortex_ws_outbound_dropped_total \d+/);

    // A reading client keeps up with the newest events; seq gaps (if any) are
    // what it would repair with `replay`.
    await waitFor(() => fast.frames.some((f) => f.type === "big" && f.i === 399), 10_000);
    const seqs = fast.frames.filter((f) => f.type === "big").map((f) => f.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    slow.ws.terminate();
    fast.ws.close();
  }, 30_000);
});
