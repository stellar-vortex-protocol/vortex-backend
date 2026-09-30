import {
  Backplane,
  BackplaneHandler,
  BackplaneHealth,
  BackplaneMetrics,
  UnsequencedEvent,
} from "./backplane.types";

/**
 * The subset of an ioredis client the backplane uses. Declared structurally so
 * tests can supply an in-memory broker.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  xread(...args: (string | number)[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  xrevrange(key: string, end: string, start: string, count: "COUNT", n: number): Promise<Array<[string, string[]]>>;
  disconnect(): void;
}

export interface RedisBackplaneOptions {
  /** Factory for a new connection; two are opened (commands + blocking reads). */
  createClient: () => RedisLike;
  keyPrefix?: string;
  /** Approximate stream length retained in Redis. */
  maxLen?: number;
  /** XREAD block timeout. */
  blockMs?: number;
  /** Max events waiting to be sequenced; beyond this new events are dropped. */
  publishQueueMax?: number;
  metrics?: BackplaneMetrics;
}

/**
 * INCR + XADD in one script so stream order always equals sequence order,
 * whichever replica publishes.
 */
const PUBLISH_SCRIPT = `
local seq = redis.call('INCR', KEYS[1])
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], '*', 'seq', seq, 'event', ARGV[2])
return seq
`;

const RETRY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Redis Streams backplane (issue #454).
 *
 * - Sequencing: a Lua script INCRs a global counter and XADDs the event
 *   atomically, so `seq` is global and stream order matches it.
 * - Delivery: each replica XREADs the stream from the last id it delivered.
 *   After a Redis reconnect it resumes from that id, so events are neither
 *   lost (within `maxLen`), duplicated, nor reordered; `seq` is also checked
 *   to drop any duplicate defensively.
 * - Publishing is queued and drained in order in the background, so request
 *   handlers never wait on Redis; a full queue drops and counts events.
 */
export class RedisBackplane implements Backplane {
  readonly mode = "redis" as const;
  private readonly seqKey: string;
  private readonly streamKey: string;
  private readonly maxLen: number;
  private readonly blockMs: number;
  private readonly publishQueueMax: number;
  private command?: RedisLike;
  private reader?: RedisLike;
  private handler: BackplaneHandler | null = null;
  private readonly queue: UnsequencedEvent[] = [];
  private draining = false;
  private closed = false;
  private lastId = "0-0";
  private lastSeq = 0;
  private readerHealthy = false;
  private publishHealthy = true;
  private lastError?: string;
  private readLoop?: Promise<void>;

  constructor(private readonly opts: RedisBackplaneOptions) {
    const prefix = opts.keyPrefix ?? "vortex:ws";
    this.seqKey = `${prefix}:seq`;
    this.streamKey = `${prefix}:events`;
    this.maxLen = opts.maxLen ?? 10_000;
    this.blockMs = opts.blockMs ?? 5_000;
    this.publishQueueMax = opts.publishQueueMax ?? 10_000;
  }

  async start(handler: BackplaneHandler): Promise<void> {
    this.handler = handler;
    this.command = this.opts.createClient();
    this.reader = this.opts.createClient();
    // Start after the newest existing entry: a new replica serves live events
    // and older history from replay, not a re-broadcast of the stream.
    try {
      const [last] = await this.command.xrevrange(this.streamKey, "+", "-", "COUNT", 1);
      if (last) {
        this.lastId = last[0];
        this.lastSeq = Number(fieldsToMap(last[1]).seq ?? 0);
      }
      this.setReaderHealthy(true);
    } catch (err) {
      this.fail("reader", err);
    }
    this.readLoop = this.read();
  }

  publish(event: UnsequencedEvent): Promise<void> {
    if (this.closed) {
      this.opts.metrics?.incDropped("closed");
      return Promise.resolve();
    }
    if (this.queue.length >= this.publishQueueMax) {
      this.opts.metrics?.incDropped("queue_full");
      return Promise.resolve();
    }
    this.queue.push(event);
    void this.drain();
    return Promise.resolve();
  }

  health(): BackplaneHealth {
    const status = !this.readerHealthy ? "down" : this.publishHealthy ? "ok" : "degraded";
    return {
      mode: this.mode,
      status,
      lastSeq: this.lastSeq,
      pendingPublishes: this.queue.length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.command?.disconnect();
    this.reader?.disconnect();
    await this.readLoop?.catch(() => undefined);
  }

  /** Sequences queued events one at a time so this replica's publish order is kept. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const started = performance.now();
        try {
          await this.command!.eval(PUBLISH_SCRIPT, 2, this.seqKey, this.streamKey, this.maxLen, JSON.stringify(this.queue[0]));
          this.queue.shift();
          this.publishHealthy = true;
          this.opts.metrics?.observePublish((performance.now() - started) / 1000);
        } catch (err) {
          // Keep the event at the head and retry: order is preserved and the
          // bounded queue caps memory during an outage.
          this.publishHealthy = false;
          this.fail("publish", err);
          await sleep(RETRY_MS);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async read(): Promise<void> {
    while (!this.closed) {
      try {
        const res = await this.reader!.xread("COUNT", 100, "BLOCK", this.blockMs, "STREAMS", this.streamKey, this.lastId);
        this.setReaderHealthy(true);
        for (const [, entries] of res ?? []) {
          for (const [id, fields] of entries) {
            this.lastId = id;
            await this.deliver(fieldsToMap(fields));
          }
        }
      } catch (err) {
        if (this.closed) return;
        this.setReaderHealthy(false);
        this.fail("reader", err);
        await sleep(RETRY_MS);
      }
    }
  }

  private async deliver(fields: Record<string, string>): Promise<void> {
    const seq = Number(fields.seq);
    if (!Number.isInteger(seq) || seq <= this.lastSeq) return; // duplicate or garbage
    let event: UnsequencedEvent;
    try {
      event = JSON.parse(fields.event);
    } catch {
      this.opts.metrics?.incDropped("malformed");
      this.lastSeq = seq;
      return;
    }
    this.lastSeq = seq;
    await this.handler?.({ ...event, seq });
  }

  private setReaderHealthy(healthy: boolean) {
    if (this.readerHealthy !== healthy) this.opts.metrics?.setConnected(healthy);
    this.readerHealthy = healthy;
  }

  private fail(where: string, err: unknown) {
    this.lastError = `${where}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function fieldsToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1];
  return out;
}
