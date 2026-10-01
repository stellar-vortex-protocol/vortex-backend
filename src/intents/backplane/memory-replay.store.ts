import type { BroadcastEvent, ReplayStore, SequencedEvent } from "./replay-store";

/** Default retention: how many sequenced events to keep (see WS_REPLAY_MAX_EVENTS). */
export const DEFAULT_REPLAY_MAX_EVENTS = 500;

/** Options shared by the in-memory replay store. */
export interface MemoryReplayOptions {
  /** Retain at most this many events (count-based retention). Default 500. */
  maxEvents?: number;
  /**
   * Retain events for at most this many milliseconds (time-based retention).
   * `0` (default) disables age-based expiry.
   */
  maxAgeMs?: number;
  /** Clock used for age-based retention — injectable for deterministic tests. */
  clock?: () => number;
}

/**
 * In-process replay store (issue #457).
 *
 * Drop-in replacement for the old gateway-internal ring buffer, behind the
 * {@link ReplayStore} interface. Retention is enforced on every append by
 * count (`maxEvents`) and, when configured, by age (`maxAgeMs`). All reads
 * (`since`, `oldestSeq`, `latestSeq`, `size`) are O(1)/O(n) over the
 * *retained* window only — history outside the window is gone, exactly like
 * Redis-side `MAXLEN` trimming.
 *
 * `latestSeq()` reports the highest `seq` ever allocated (not merely the
 * highest retained) so a gateway that has just booted can tell a connecting
 * client where the log currently stands.
 */
export class MemoryReplayStore implements ReplayStore {
  private readonly entries: { event: SequencedEvent; ts: number }[] = [];
  private seq = 0;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;

  constructor(options: MemoryReplayOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_REPLAY_MAX_EVENTS;
    this.maxAgeMs = options.maxAgeMs ?? 0;
    this.clock = options.clock ?? Date.now;
  }

  async append(event: BroadcastEvent): Promise<SequencedEvent> {
    const seq = ++this.seq;
    const sequenced = { ...event, seq } as SequencedEvent;
    this.entries.push({ event: sequenced, ts: this.clock() });
    this.prune();
    return sequenced;
  }

  async since(fromSeq: number): Promise<SequencedEvent[]> {
    return this.entries
      .filter((entry) => entry.event.seq > fromSeq)
      .map((entry) => entry.event);
  }

  async oldestSeq(): Promise<number> {
    return this.entries.length === 0 ? -1 : this.entries[0].event.seq;
  }

  async latestSeq(): Promise<number> {
    return this.seq;
  }

  async size(): Promise<number> {
    return this.entries.length;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  close(): void {}

  /** Drop events past the count or age retention boundary. */
  private prune(): void {
    while (this.entries.length > this.maxEvents) {
      this.entries.shift();
    }
    if (this.maxAgeMs > 0) {
      const cutoff = this.clock() - this.maxAgeMs;
      while (this.entries.length > 0 && this.entries[0].ts < cutoff) {
        this.entries.shift();
      }
    }
  }
}
