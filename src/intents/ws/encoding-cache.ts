import { encode as msgpackEncode } from "@msgpack/msgpack";

/**
 * Encoding format negotiated per WebSocket connection (Activity 1).
 */
export type EncodingFormat = "json" | "msgpack";

/**
 * Cache entry: pre-serialized event payload in multiple encodings.
 * 
 * Events are serialized once per encoding, then broadcast to all clients
 * that negotiated that format. This amortizes serialization CPU across
 * thousands of connections.
 */
interface CachedEvent {
  json: string;
  msgpack?: Uint8Array;
  createdAt: number;
}

/**
 * LRU-style encoding cache for WebSocket events (Activity 1).
 * 
 * - Keyed by event `seq` number (globally unique)
 * - Capacity matches the replay buffer size
 * - TTL evicts stale entries to prevent unbounded growth
 * 
 * Design rationale:
 * - Serialize once per encoding, not once per client (O(encodings) vs O(clients))
 * - At 10k connections with 2 encodings, this saves 9,998 serializations per event
 * - Memory overhead: ~1 KB JSON + ~700 bytes msgpack per cached event
 *   → 500 events × 1.7 KB = ~850 KB total (negligible)
 */
export class EncodingCache {
  private readonly cache = new Map<number, CachedEvent>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  /**
   * @param capacity - Max number of events to cache (should match replay buffer size)
   * @param ttlMs - Time-to-live for cached entries (ms)
   */
  constructor(capacity = 500, ttlMs = 300_000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  /**
   * Get or create a cached encoding for an event.
   * 
   * @param seq - Global sequence number (unique key)
   * @param event - Event object to serialize if not cached
   * @param format - Desired encoding format
   * @returns Pre-serialized payload
   */
  get(seq: number, event: Record<string, unknown>, format: EncodingFormat): string | Uint8Array {
    let cached = this.cache.get(seq);

    if (!cached) {
      // First time seeing this seq → serialize JSON (always needed)
      cached = {
        json: JSON.stringify({ seq, ...event }),
        createdAt: Date.now(),
      };
      this.cache.set(seq, cached);
      this.evictOldest();
    }

    // Lazily serialize msgpack only if a client needs it
    if (format === "msgpack" && !cached.msgpack) {
      cached.msgpack = msgpackEncode({ seq, ...event });
    }

    return format === "msgpack" ? cached.msgpack! : cached.json;
  }

  /**
   * Evict the oldest entry when capacity is exceeded.
   * Also prunes stale entries beyond TTL.
   */
  private evictOldest(): void {
    const now = Date.now();
    
    // First pass: remove stale entries
    for (const [seq, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(seq);
      }
    }

    // Second pass: enforce capacity (evict oldest by insertion order)
    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  /**
   * Clear all cached entries (for testing).
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (for metrics/debugging).
   */
  size(): number {
    return this.cache.size;
  }
}
