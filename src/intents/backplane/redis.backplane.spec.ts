import { FakeRedisBroker } from "./testing/fake-redis";
import { MemoryBackplane } from "./memory.backplane";
import { RedisBackplane } from "./redis.backplane";
import { SequencedEvent } from "./backplane.types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await sleep(5);
  }
}

describe("RedisBackplane", () => {
  let broker: FakeRedisBroker;
  const planes: RedisBackplane[] = [];

  function replica(received: SequencedEvent[], extra: Partial<ConstructorParameters<typeof RedisBackplane>[0]> = {}) {
    const plane = new RedisBackplane({ createClient: () => broker.client(), blockMs: 50, ...extra });
    planes.push(plane);
    return plane.start((e) => {
      received.push(e);
    }).then(() => plane);
  }

  beforeEach(() => {
    broker = new FakeRedisBroker();
  });

  afterEach(async () => {
    await Promise.all(planes.splice(0).map((p) => p.close()));
  });

  it("gives every replica every event once, in one global sequence order", async () => {
    const got: SequencedEvent[][] = [[], [], []];
    const [a, b, c] = await Promise.all(got.map((r) => replica(r)));

    for (let i = 0; i < 30; i++) void [a, b, c][i % 3].publish({ type: "tick", i });
    await waitFor(() => got.every((r) => r.length === 30));

    const seqs = got.map((r) => r.map((e) => e.seq));
    expect(seqs[0]).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(seqs[1]).toEqual(seqs[0]);
    expect(seqs[2]).toEqual(seqs[0]);
    expect(got[1].map((e) => e.i)).toEqual(got[0].map((e) => e.i));
  });

  it("resumes after a Redis outage without losing, duplicating or reordering events", async () => {
    const got: SequencedEvent[][] = [[], []];
    const [a, b] = await Promise.all(got.map((r) => replica(r)));

    for (let i = 0; i < 5; i++) void a.publish({ type: "before", i });
    await waitFor(() => got.every((r) => r.length === 5));

    broker.outage(300);
    for (let i = 0; i < 5; i++) void b.publish({ type: "during", i });
    await sleep(50);
    expect(b.health().status).not.toBe("ok");

    await waitFor(() => got.every((r) => r.length === 10));
    for (const r of got) expect(r.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(got[0].slice(5).map((e) => e.i)).toEqual([0, 1, 2, 3, 4]);
    await waitFor(() => a.health().status === "ok");
  });

  it("does not block publishers and drops beyond the queue bound", async () => {
    const dropped: string[] = [];
    const plane = await replica([], {
      publishQueueMax: 2,
      metrics: { observePublish: () => undefined, incDropped: (r) => dropped.push(r), setConnected: () => undefined },
    });
    broker.outage(200);
    const started = Date.now();
    await Promise.all([1, 2, 3, 4].map((i) => plane.publish({ type: "x", i })));
    expect(Date.now() - started).toBeLessThan(50);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
  });
});

describe("MemoryBackplane", () => {
  it("sequences locally and delivers before publish resolves", async () => {
    const got: SequencedEvent[] = [];
    const plane = new MemoryBackplane();
    await plane.start((e) => {
      got.push(e);
    });
    await plane.publish({ type: "a" });
    await plane.publish({ type: "b" });
    expect(got.map((e) => [e.type, e.seq])).toEqual([["a", 1], ["b", 2]]);
    expect(plane.health()).toMatchObject({ mode: "memory", status: "ok", lastSeq: 2 });
  });
});
