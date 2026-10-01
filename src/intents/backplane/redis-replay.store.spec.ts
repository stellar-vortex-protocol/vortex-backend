import { RedisReplayStore } from "./redis-replay.store";
import type { RedisClientLike } from "./replay-store";

/**
 * Minimal in-memory stand-in for the Redis commands {@link RedisReplayStore}
 * uses (`INCR`, `XADD MAXLEN ~`, `XRANGE`, `XDEL`, `XLEN`, `GET`).
 *
 * Enough fidelity for contract-level assertions: entry IDs are `<seq>-0`,
 * `MAXLEN ~` trims from the head, `XRANGE` honours start/end/COUNT, and the
 * shared counter persists across "restarts" (a new store over the same
 * backing object) the way the real `vortex:ws:seq` key does.
 */
class FakeRedis implements RedisClientLike {
  readonly counters = new Map<string, number>();
  readonly streams = new Map<string, Array<{ id: string; fields: string[] }>>();
  disconnected = false;
  /** Last XADD args, for retention-argument assertions. */
  lastXadd: unknown[] = [];

  on(): unknown {
    return this;
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async get(key: string): Promise<string | null> {
    const value = this.counters.get(key);
    return value === undefined ? null : String(value);
  }

  async xadd(key: string, ...args: (string | number)[]): Promise<string> {
    this.lastXadd = args;
    const entries = this.streams.get(key) ?? [];

    // `XADD key MAXLEN ~ <n> <id> field value ...` — trim from the head.
    let idIndex = 0;
    if (String(args[0]).toUpperCase() === "MAXLEN") {
      const limit = Number(args[2]);
      idIndex = 3;
      const id = String(args[idIndex]);
      entries.push({ id, fields: toFields(args.slice(idIndex + 1)) });
      while (entries.length > limit) entries.shift();
    } else {
      entries.push({ id: String(args[0]), fields: toFields(args.slice(1)) });
    }

    this.streams.set(key, entries);
    return String(args[idIndex]);
  }

  async xrange(
    key: string,
    start: string,
    end: string,
    ...args: (string | number)[]
  ): Promise<[string, string[]][]> {
    const countIdx = args.findIndex((a) => String(a).toUpperCase() === "COUNT");
    const limit = countIdx === -1 ? Infinity : Number(args[countIdx + 1]);
    const entries = this.streams.get(key) ?? [];
    const startSeq = start === "-" ? -Infinity : Number(start.split("-")[0]);
    const endSeq = end === "+" ? Infinity : Number(end.split("-")[0]);

    const matched = entries
      .filter((e) => {
        const seq = Number(e.id.split("-")[0]);
        // XRANGE start is inclusive — IDs are `<seq>-0`, so a requested
        // `n-0` includes seq n.
        return seq >= startSeq && seq <= endSeq;
      })
      .slice(0, limit);

    return matched.map((e) => [e.id, e.fields]);
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    const entries = this.streams.get(key) ?? [];
    const doomed = new Set(ids);
    const kept = entries.filter((e) => !doomed.has(e.id));
    this.streams.set(key, kept);
    return entries.length - kept.length;
  }

  async xlen(key: string): Promise<number> {
    return (this.streams.get(key) ?? []).length;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

function toFields(args: (string | number)[]): string[] {
  return args.map(String);
}

function makeStore(
  redis: FakeRedis,
  options: { maxEvents: number; maxAgeMs?: number; sweepIntervalMs?: number } = { maxEvents: 100 },
): RedisReplayStore {
  return new RedisReplayStore(redis, {
    ...options,
    streamKey: "test:replay",
    seqKey: "test:seq",
  });
}

describe("RedisReplayStore", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it("assigns sequence numbers from the shared counter and XADDs them as entry IDs", async () => {
    const store = makeStore(redis, { maxEvents: 10 });
    const a = await store.append({ type: "a" });
    const b = await store.append({ type: "b" });

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(redis.streams.get("test:replay")?.map((e) => e.id)).toEqual(["1-0", "2-0"]);
    // MAXLEN ~ retention is applied server-side on every append.
    expect(String(redis.lastXadd[0]).toUpperCase()).toBe("MAXLEN");
    expect(redis.lastXadd[2]).toBe(10);
  });

  it("serializes concurrent appends so IDs stay strictly increasing", async () => {
    const store = makeStore(redis, { maxEvents: 100 });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.append({ type: "e", i })),
    );
    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(25);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("since() returns events after fromSeq in ascending order", async () => {
    const store = makeStore(redis, { maxEvents: 100 });
    for (let i = 1; i <= 5; i++) await store.append({ type: "e", i });

    expect((await store.since(3)).map((e) => e.seq)).toEqual([4, 5]);
    expect(await store.since(5)).toEqual([]);
    expect((await store.since(-1)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("pages through XRANGE COUNT windows instead of one giant reply", async () => {
    const store = makeStore(redis, { maxEvents: 5_000 });
    for (let i = 1; i <= 2_500; i++) await store.append({ type: "e", i });

    let xrangeCalls = 0;
    const originalXrange = redis.xrange.bind(redis);
    redis.xrange = async (...parameters: Parameters<typeof originalXrange>) => {
      xrangeCalls += 1;
      return originalXrange(...parameters);
    };

    const events = await store.since(0);
    expect(events).toHaveLength(2_500);
    // 2_500 events at SCAN_BATCH=1000 → 3 pages (the third returns < 1000).
    expect(xrangeCalls).toBe(3);
  });

  it("count retention: trims the oldest entries at the MAXLEN boundary", async () => {
    const store = makeStore(redis, { maxEvents: 3 });
    for (let i = 1; i <= 4; i++) await store.append({ type: "e", i });

    expect(await store.size()).toBe(3);
    expect(await store.oldestSeq()).toBe(2);
    expect((await store.since(0)).map((e) => e.seq)).toEqual([2, 3, 4]);
    // The counter (resume point) still reflects the full history.
    expect(await store.latestSeq()).toBe(4);
  });

  it("oldestSeq is -1 and latestSeq 0 on an empty store", async () => {
    const store = makeStore(redis, { maxEvents: 10 });
    expect(await store.oldestSeq()).toBe(-1);
    expect(await store.latestSeq()).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it("survives a restart: a new store over the same Redis resumes the sequence", async () => {
    const first = makeStore(redis, { maxEvents: 10 });
    await first.append({ type: "before-restart" });
    await first.append({ type: "also-before" });

    // "Restart": a brand-new store instance over the same backing Redis.
    const second = makeStore(redis, { maxEvents: 10 });
    expect(await second.latestSeq()).toBe(2);

    const resumed = await second.append({ type: "after-restart" });
    expect(resumed.seq).toBe(3);
    expect((await second.since(0)).map((e) => e.type)).toEqual([
      "before-restart",
      "also-before",
      "after-restart",
    ]);
  });

  it("age retention: sweeps entries older than maxAgeMs with bounded XRANGE pages", async () => {
    const store = makeStore(redis, { maxEvents: 100, maxAgeMs: 1_000, sweepIntervalMs: 0 });
    // Seed three old events with hand-crafted timestamps.
    await store.append({ type: "old-1" });
    await store.append({ type: "old-2" });
    await store.append({ type: "old-3" });
    const entries = redis.streams.get("test:replay")!;
    for (const entry of entries) {
      entry.fields[entry.fields.indexOf("ts")] = String(Date.now() - 60_000);
    }

    // First append after the entries aged out triggers the sweep.
    await store.append({ type: "fresh" });

    const types = (await store.since(-1)).map((e) => e.type);
    expect(types).toEqual(["fresh"]);
    expect(await store.size()).toBe(1);
    // Sequence numbers are not renumbered by expiry.
    expect(await store.latestSeq()).toBe(4);
    expect(await store.oldestSeq()).toBe(4);
  });

  it("does not sweep when time retention is disabled", async () => {
    const store = makeStore(redis, { maxEvents: 100 });
    await store.append({ type: "ancient" });
    const entries = redis.streams.get("test:replay")!;
    for (const entry of entries) {
      entry.fields[entry.fields.indexOf("ts")] = String(Date.now() - 86_400_000);
    }

    await store.append({ type: "fresh" });
    expect(await store.size()).toBe(2);
  });

  it("close() disconnects the client", () => {
    const store = makeStore(redis, { maxEvents: 10 });
    store.close();
    expect(redis.disconnected).toBe(true);
  });
});
