import { EncodingCache } from "./encoding-cache";

describe("EncodingCache", () => {
  let cache: EncodingCache;

  beforeEach(() => {
    cache = new EncodingCache(3, 100); // Small capacity and TTL for testing
  });

  afterEach(() => {
    cache.clear();
  });

  it("should cache JSON encoding", () => {
    const event = { type: "test", data: "hello" };
    const result1 = cache.get(1, event, "json");
    const result2 = cache.get(1, event, "json");

    expect(result1).toBe(result2); // Same string reference
    expect(typeof result1).toBe("string");
    expect(result1).toContain('"seq":1');
  });

  it("should cache MessagePack encoding lazily", () => {
    const event = { type: "test", data: "hello" };
    
    // First call: JSON cached, msgpack not yet
    const json = cache.get(1, event, "json");
    expect(cache.size()).toBe(1);

    // Second call: msgpack cached lazily
    const msgpack = cache.get(1, event, "msgpack");
    expect(msgpack).toBeInstanceOf(Uint8Array);
    expect(cache.size()).toBe(1);

    // Third call: both cached, same references
    const json2 = cache.get(1, event, "json");
    const msgpack2 = cache.get(1, event, "msgpack");
    
    expect(json).toBe(json2);
    expect(msgpack).toBe(msgpack2);
  });

  it("should evict oldest entry when capacity exceeded", () => {
    cache.get(1, { type: "event1" }, "json");
    cache.get(2, { type: "event2" }, "json");
    cache.get(3, { type: "event3" }, "json");
    expect(cache.size()).toBe(3);

    // Adding 4th entry should evict seq 1
    cache.get(4, { type: "event4" }, "json");
    expect(cache.size()).toBe(3);

    // Verify seq 1 is evicted (new JSON string instance)
    const result1a = cache.get(1, { type: "event1" }, "json");
    const result1b = cache.get(1, { type: "event1" }, "json");
    expect(result1a).toBe(result1b); // Re-cached
    expect(cache.size()).toBe(3); // Still capped at 3
  });

  it("should evict entries after TTL", async () => {
    cache.get(1, { type: "test" }, "json");
    expect(cache.size()).toBe(1);

    // Wait for TTL expiry
    await new Promise(resolve => setTimeout(resolve, 150));

    // Trigger eviction by adding new entry
    cache.get(2, { type: "test2" }, "json");
    
    // Seq 1 should be gone due to TTL
    expect(cache.size()).toBeLessThanOrEqual(1);
  });

  it("should handle multiple encoding formats independently", () => {
    const event = { type: "test", data: "hello" };

    const json = cache.get(1, event, "json");
    const msgpack = cache.get(1, event, "msgpack");

    expect(typeof json).toBe("string");
    expect(msgpack).toBeInstanceOf(Uint8Array);
    expect(json).not.toEqual(msgpack);
  });

  it("should clear all entries", () => {
    cache.get(1, { type: "event1" }, "json");
    cache.get(2, { type: "event2" }, "json");
    cache.get(3, { type: "event3" }, "json");
    
    expect(cache.size()).toBe(3);
    
    cache.clear();
    
    expect(cache.size()).toBe(0);
  });

  it("should serialize seq into the payload", () => {
    const event = { type: "intent_created", data: "test" };
    const json = cache.get(42, event, "json") as string;
    
    const parsed = JSON.parse(json);
    expect(parsed.seq).toBe(42);
    expect(parsed.type).toBe("intent_created");
    expect(parsed.data).toBe("test");
  });
});
