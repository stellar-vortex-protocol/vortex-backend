import { logger } from "../../common/logger";
import type {
  BroadcastEvent,
  RedisClientLike,
  ReplayStore,
  SequencedEvent,
} from "./replay-store";

/** Options for the Redis Streams replay store. */
export interface RedisReplayOptions {
  /** Retain at most this many events (`XADD MAXLEN ~`). */
  maxEvents: number;
  /** Retain events for at most this many ms (0 = disabled). */
  maxAgeMs?: number;
  /** Stream key. Override only in tests. */
  streamKey?: string;
  /** Sequence-counter key. Override only in tests. */
  seqKey?: string;
  /** Minimum spacing between age-based sweeps. Default 10 s. */
  sweepIntervalMs?: number;
}

/** Entries per `XRANGE` page when reading a replay window. */
const SCAN_BATCH = 1000;
/** Entries inspected per age-sweep batch, and batches per sweep. */
const SWEEP_BATCH = 100;
const MAX_SWEEP_BATCHES = 10;

/**
 * Redis Streams replay store (issue #457).
 *
 * Layout:
 *
 * - `vortex:ws:replay` — a stream whose entry IDs are `<seq>-0`, so the
 *   sequence range the protocol speaks maps directly onto Redis range
 *   queries. Each entry carries the full event as a `payload` field plus a
 *   `ts` field for age-based retention.
 * - `vortex:ws:seq` — an `INCR` counter that allocates sequence numbers.
 *   Being server-side, every replica appends into the same log with unique,
 *   strictly increasing `seq` values — a client that reconnects to a
 *   different pod replays the same sequence it would have seen on the old
 *   one.
 *
 * Retention:
 *
 * - **Count** — `XADD MAXLEN ~ <maxEvents>` trims server-side on every
 *   append; the gateway never reads outside the requested window.
 * - **Age** — Redis can only trim by time when IDs grow with time, and these
 *   IDs are sequence numbers, so expiry is a bounded sweep: every
 *   `sweepIntervalMs`, up to `MAX_SWEEP_BATCHES` × `SWEEP_BATCH` of the
 *   oldest entries are inspected with `XRANGE … COUNT` and expired ones
 *   `XDEL`ed. Entries are written in time order, so the sweep stops at the
 *   first fresh entry — never loading the whole stream.
 *
 * `append()` calls are funnelled through a promise chain so concurrent
 * broadcasts cannot interleave `INCR` and `XADD` out of order (a lower ID
 * after a higher one would be rejected by Redis).
 */
export class RedisReplayStore implements ReplayStore {
  private readonly redis: RedisClientLike;
  private readonly streamKey: string;
  private readonly seqKey: string;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly sweepIntervalMs: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSweepAt = 0;

  constructor(redis: RedisClientLike, options: RedisReplayOptions) {
    this.redis = redis;
    this.streamKey = options.streamKey ?? "vortex:ws:replay";
    this.seqKey = options.seqKey ?? "vortex:ws:seq";
    this.maxEvents = options.maxEvents;
    this.maxAgeMs = options.maxAgeMs ?? 0;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
  }

  append(event: BroadcastEvent): Promise<SequencedEvent> {
    const run = async (): Promise<SequencedEvent> => {
      const seq = Number(await this.redis.incr(this.seqKey));
      const sequenced = { ...event, seq } as SequencedEvent;
      await this.redis.xadd(
        this.streamKey,
        "MAXLEN",
        "~",
        this.maxEvents,
        `${seq}-0`,
        "payload",
        JSON.stringify(sequenced),
        "ts",
        String(Date.now()),
      );
      await this.sweepExpired();
      return sequenced;
    };

    // Serialize: the next append starts only after the previous INCR+XADD
    // pair completed, preserving ID order under concurrent broadcasts.
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async since(fromSeq: number): Promise<SequencedEvent[]> {
    const events: SequencedEvent[] = [];
    // Inclusive start at the first id above fromSeq; page until the window
    // is exhausted so a 10k-event replay never materialises one giant reply.
    let start = `${fromSeq + 1}-0`;

    for (;;) {
      const batch = await this.redis.xrange(
        this.streamKey,
        start,
        "+",
        "COUNT",
        SCAN_BATCH,
      );
      if (batch.length === 0) break;

      for (const [id, fields] of batch) {
        const payload = fieldValue(fields, "payload");
        if (payload === null) {
          logger.warn(`ws replay: entry ${id} has no payload field — skipped`);
          continue;
        }
        try {
          events.push(JSON.parse(payload) as SequencedEvent);
        } catch {
          logger.warn(`ws replay: entry ${id} has an unparseable payload — skipped`);
        }
      }

      if (batch.length < SCAN_BATCH) break;
      const lastSeq = Number(batch[batch.length - 1][0].split("-")[0]);
      start = `${lastSeq + 1}-0`;
    }

    return events;
  }

  async oldestSeq(): Promise<number> {
    const batch = await this.redis.xrange(this.streamKey, "-", "+", "COUNT", 1);
    if (batch.length === 0) return -1;
    return Number(batch[0][0].split("-")[0]);
  }

  async latestSeq(): Promise<number> {
    const value = await this.redis.get(this.seqKey);
    const parsed = Number.parseInt(value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async size(): Promise<number> {
    return Number(await this.redis.xlen(this.streamKey));
  }

  close(): void {
    this.redis.disconnect();
  }

  /**
   * Age-based retention: delete entries whose `ts` is older than the window.
   *
   * Bounded by construction (page count × page size per invocation) and
   * rate-limited to one sweep per `sweepIntervalMs`. Because appends are
   * timestamped in order, stopping at the first fresh entry is correct.
   */
  private async sweepExpired(): Promise<void> {
    if (this.maxAgeMs <= 0) return;
    const now = Date.now();
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    const cutoff = now - this.maxAgeMs;

    for (let page = 0; page < MAX_SWEEP_BATCHES; page++) {
      const batch = await this.redis.xrange(
        this.streamKey,
        "-",
        "+",
        "COUNT",
        SWEEP_BATCH,
      );
      if (batch.length === 0) return;

      const expired: string[] = [];
      for (const [id, fields] of batch) {
        const ts = Number(fieldValue(fields, "ts"));
        if (Number.isFinite(ts) && ts < cutoff) expired.push(id);
      }
      if (expired.length === 0) return;

      await this.redis.xdel(this.streamKey, ...expired);
      if (expired.length < batch.length) return; // reached a fresh entry
    }
  }
}

function fieldValue(fields: string[], name: string): string | null {
  const index = fields.indexOf(name);
  return index === -1 ? null : fields[index + 1] ?? null;
}
