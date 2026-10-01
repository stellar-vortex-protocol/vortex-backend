import { MemoryReplayStore, DEFAULT_REPLAY_MAX_EVENTS } from "./memory-replay.store";

describe("MemoryReplayStore", () => {
  it("assigns strictly increasing sequence numbers starting at 1", async () => {
    const store = new MemoryReplayStore();
    const a = await store.append({ type: "a" });
    const b = await store.append({ type: "b" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.type).toBe("a");
  });

  it("reports -1 oldestSeq / 0 latestSeq when empty", async () => {
    const store = new MemoryReplayStore();
    expect(await store.oldestSeq()).toBe(-1);
    expect(await store.latestSeq()).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it("since() returns only events with seq > fromSeq, in order", async () => {
    const store = new MemoryReplayStore();
    for (let i = 1; i <= 5; i++) await store.append({ type: "e", i });
    expect((await store.since(3)).map((e) => e.seq)).toEqual([4, 5]);
    expect(await store.since(5)).toEqual([]);
    expect(await store.since(99)).toEqual([]);
  });

  it("count retention: evicts the oldest event at the boundary", async () => {
    const store = new MemoryReplayStore({ maxEvents: 3 });
    for (let i = 1; i <= 4; i++) await store.append({ type: "e", i });

    // Boundary: exactly maxEvents retained, first event trimmed.
    expect(await store.size()).toBe(3);
    expect(await store.oldestSeq()).toBe(2);
    expect((await store.since(0)).map((e) => e.seq)).toEqual([2, 3, 4]);

    // latestSeq keeps counting past the window (resume point after eviction).
    expect(await store.latestSeq()).toBe(4);
  });

  it("count retention: an exact fit at the boundary retains everything", async () => {
    const store = new MemoryReplayStore({ maxEvents: 3 });
    for (let i = 1; i <= 3; i++) await store.append({ type: "e", i });
    expect(await store.size()).toBe(3);
    expect(await store.oldestSeq()).toBe(1);
  });

  it("time retention: drops events older than maxAgeMs, keeps fresh ones", async () => {
    let now = 1_000_000;
    const store = new MemoryReplayStore({ maxAgeMs: 10_000, clock: () => now });

    await store.append({ type: "old" });
    now += 9_999; // still inside the window (boundary is strict: ts < cutoff)
    await store.append({ type: "boundary" });
    expect(await store.size()).toBe(2);

    now += 2; // old: 1_000_000 < 1_010_001 - 10_000 → expired (strict cutoff)
    await store.append({ type: "fresh" });
    expect(await store.size()).toBe(2);
    expect((await store.since(-1)).map((e) => e.type)).toEqual(["boundary", "fresh"]);
    expect(await store.oldestSeq()).toBe(2);
    expect(await store.latestSeq()).toBe(3);
  });

  it("time retention disabled by default (maxAgeMs = 0)", async () => {
    let now = 0;
    const store = new MemoryReplayStore({ clock: () => now });
    await store.append({ type: "ancient" });
    now = Number.MAX_SAFE_INTEGER;
    await store.append({ type: "fresh" });
    expect(await store.oldestSeq()).toBe(1);
  });

  it("defaults to DEFAULT_REPLAY_MAX_EVENTS retention", async () => {
    const store = new MemoryReplayStore();
    expect(DEFAULT_REPLAY_MAX_EVENTS).toBe(500);
    for (let i = 1; i <= DEFAULT_REPLAY_MAX_EVENTS + 1; i++) await store.append({ type: "e" });
    expect(await store.size()).toBe(DEFAULT_REPLAY_MAX_EVENTS);
    expect(await store.oldestSeq()).toBe(2);
  });

  it("latestSeq stays at the highest allocated value even when everything is evicted", async () => {
    const store = new MemoryReplayStore({ maxEvents: 1 });
    await store.append({ type: "a" });
    await store.append({ type: "b" });
    expect(await store.size()).toBe(1);
    expect(await store.latestSeq()).toBe(2);

    // A second store sharing nothing (restart with memory backend) starts fresh.
    const fresh = new MemoryReplayStore();
    expect(await fresh.latestSeq()).toBe(0);
  });

  it("replays 10_000 events in well under one second", async () => {
    const store = new MemoryReplayStore({ maxEvents: 20_000 });
    for (let i = 0; i < 10_000; i++) await store.append({ type: "tick", i });

    const started = performance.now();
    const events = await store.since(0);
    const elapsed = performance.now() - started;

    expect(events).toHaveLength(10_000);
    expect(events[0].seq).toBe(1);
    expect(events[9_999].seq).toBe(10_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});
