import { logger } from "../../common/logger";
import { MemoryReplayStore, DEFAULT_REPLAY_MAX_EVENTS } from "./memory-replay.store";
import { RedisReplayStore } from "./redis-replay.store";

/**
 * Durable event replay (issue #457)
 * ─────────────────────────────────────────────────────────────────────
 * The WebSocket feed's replay log is behind the {@link ReplayStore}
 * interface so the same gateway logic can run against an in-process store
 * (dev/test, single replica) or Redis Streams (production, survives restarts
 * and replica switches).
 *
 * Sequence semantics are identical for both implementations:
 *
 * - `append()` assigns the next `seq`, persists the event, and returns the
 *   sequenced event — one atomic step so concurrent broadcasts cannot
 *   allocate the same `seq` twice.
 * - `since(fromSeq)` returns retained events with `seq > fromSeq`, in order.
 * - `oldestSeq()` is `-1` on an empty store; the gateway turns a `fromSeq`
 *   older than `oldestSeq() - 1` into a `replay_too_old` frame (the reset
 *   signal — see docs/websocket-protocol.md).
 * - `latestSeq()` is the highest `seq` ever allocated (0 when none), which
 *   seeds the `connected` frame after a restart.
 *
 * Retention is bounded by count (`WS_REPLAY_MAX_EVENTS`) and optionally by
 * age (`WS_REPLAY_MAX_AGE_MS`); infinite history is explicitly out of scope
 * (use the REST API for that).
 */

/**
 * A broadcast event before a sequence number is assigned.
 * The store spreads `seq` onto it when appending.
 */
export interface BroadcastEvent {
  type: string;
  [key: string]: unknown;
}

/** A broadcast event with its assigned sequence number. */
export interface SequencedEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Replay log abstraction (issue #457).
 *
 * Implementations must keep `append` ordering-safe (sequence numbers strictly
 * increasing in call order) and must never load history outside the retention
 * window when serving `since()`.
 */
export interface ReplayStore {
  /** Assign the next `seq`, persist the event, and return it sequenced. */
  append(event: BroadcastEvent): Promise<SequencedEvent>;

  /** Retained events with `seq > fromSeq`, in ascending order. */
  since(fromSeq: number): Promise<SequencedEvent[]>;

  /** Lowest retained `seq`, or `-1` when the store is empty. */
  oldestSeq(): Promise<number>;

  /** Highest `seq` ever allocated (0 when none — durable across restarts). */
  latestSeq(): Promise<number>;

  /** Number of retained events. */
  size(): Promise<number>;

  /** Release underlying resources (no-op for in-memory stores). */
  close?(): void | Promise<void>;
}

/** Injection token for the configured {@link ReplayStore}. */
export const REPLAY_STORE = Symbol("REPLAY_STORE");

/**
 * Build the store selected by `WS_REPLAY_STORE`.
 *
 * - `memory` (default) — {@link MemoryReplayStore}: per-process, lost on
 *   restart. Meets every protocol guarantee for a single instance.
 * - `redis` — {@link RedisReplayStore}: Redis Streams (`XADD`/`XRANGE`),
 *   shared sequence counter, durable across restarts and replica switches.
 *   Falls back to memory (with a loud warning) when the client cannot be
 *   constructed, so a missing optional dependency never blocks boot.
 *
 * Retention knobs apply to both backends:
 *
 * - `WS_REPLAY_MAX_EVENTS` — keep at most N events (default 500).
 * - `WS_REPLAY_MAX_AGE_MS` — drop events older than this (0 = disabled).
 */
export function createReplayStore(): ReplayStore {
  const backend = (process.env.WS_REPLAY_STORE ?? "memory").toLowerCase();
  const maxEvents = clampInt(process.env.WS_REPLAY_MAX_EVENTS, DEFAULT_REPLAY_MAX_EVENTS, 1);
  const maxAgeMs = clampInt(process.env.WS_REPLAY_MAX_AGE_MS, 0, 0);

  if (backend !== "redis") {
    return new MemoryReplayStore({ maxEvents, maxAgeMs });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const Redis = require("ioredis") as new (
      url: string,
      options: Record<string, unknown>,
    ) => RedisClientLike;
    const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      // Connect lazily: an unreachable Redis must not block boot — append
      // failures degrade replay (logged) while the live feed keeps flowing.
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    client.on("error", (err: Error) => {
      logger.warn(`[replay] redis error: ${err.message}`);
    });
    logger.info(
      `ws replay store: redis url=${process.env.REDIS_URL ?? "redis://localhost:6379"} ` +
        `maxEvents=${maxEvents} maxAgeMs=${maxAgeMs}`,
    );
    return new RedisReplayStore(client, { maxEvents, maxAgeMs });
  } catch (err) {
    logger.warn(
      `WS_REPLAY_STORE=redis but the ioredis package is not available ` +
        `(${(err as Error).message}); falling back to the in-memory replay store`,
    );
    return new MemoryReplayStore({ maxEvents, maxAgeMs });
  }
}

/** Minimal structural view of the ioredis commands the store uses. */
export interface RedisClientLike {
  on(event: "error", listener: (err: Error) => void): unknown;
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  xadd(
    key: string,
    ...args: (string | number)[]
  ): Promise<string>;
  xrange(
    key: string,
    start: string,
    end: string,
    ...args: (string | number)[]
  ): Promise<[string, string[]][]>;
  xdel(key: string, ...ids: string[]): Promise<number>;
  xlen(key: string): Promise<number>;
  disconnect(): void;
}

function clampInt(raw: string | undefined, fallback: number, min: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
