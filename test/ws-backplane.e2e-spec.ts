import Redis from "ioredis";
import { RedisBackplane, RedisLike } from "../src/intents/backplane/redis.backplane";
import { FakeRedisBroker } from "../src/intents/backplane/testing/fake-redis";
import { connectClient, createWsTestApp, waitFor, WsTestApp } from "./utils/create-ws-test-app";

/**
 * Issue #454 — three gateway replicas sharing one Redis backplane. Every
 * client on every replica must receive every event exactly once, in global
 * sequence order, including across a Redis outage.
 *
 * Uses a real Redis when TEST_REDIS_URL is set, otherwise an in-memory broker
 * with the same stream semantics.
 */
describe("WS Redis backplane — three replicas (e2e)", () => {
  const redisUrl = process.env.TEST_REDIS_URL;
  const broker = new FakeRedisBroker();
  const keyPrefix = `vortex:test:${Date.now()}`;
  const createClient = (): RedisLike =>
    redisUrl
      ? (new Redis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false }) as unknown as RedisLike)
      : broker.client();

  let replicas: WsTestApp[] = [];

  beforeAll(async () => {
    replicas = await Promise.all(
      [0, 1, 2].map(() =>
        createWsTestApp({
          backplane: new RedisBackplane({ createClient, keyPrefix, blockMs: 100 }),
          config: { wsBackplane: "redis" },
        }),
      ),
    );
  }, 30_000);

  afterAll(async () => {
    await Promise.all(replicas.map((r) => r.app.close()));
  });

  it("delivers every event to every client on every replica, in order, once", async () => {
    const clients = await Promise.all(replicas.flatMap((r) => [connectClient(r.url), connectClient(r.url)]));
    const events = (c: { frames: Array<Record<string, unknown>> }) => c.frames.filter((f) => f.type === "tick");

    const total = 60;
    for (let i = 0; i < total; i++) {
      // Publish from a rotating replica without awaiting: publishers must not block.
      void replicas[i % 3].gateway.broadcast({ type: "tick", i });
      if (i === 30 && !redisUrl) broker.outage(300);
    }

    await waitFor(() => clients.every((c) => events(c).length === total), 15_000);

    const reference = events(clients[0]).map((e) => e.seq as number);
    for (let k = 1; k < reference.length; k++) expect(reference[k]).toBe(reference[k - 1] + 1);
    for (const c of clients) {
      expect(events(c).map((e) => e.seq)).toEqual(reference);
      expect(events(c).map((e) => e.i)).toEqual(events(clients[0]).map((e) => e.i));
    }
    // Replay buffers agree across replicas.
    const replay = await connectClient(replicas[2].url);
    replay.ws.send(JSON.stringify({ type: "replay", fromSeq: reference[total - 6] }));
    await waitFor(() => replay.frames.some((f) => f.type === "replay_end"));
    expect(events(replay).map((e) => e.seq)).toEqual(reference.slice(total - 5));

    for (const c of [...clients, replay]) c.ws.close();
  }, 30_000);

  it("reports backplane health per replica", () => {
    for (const r of replicas) {
      expect(r.gateway.backplaneHealth()).toMatchObject({ mode: "redis", status: "ok", pendingPublishes: 0 });
    }
  });
});
