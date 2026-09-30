import type { RedisLike } from "../redis.backplane";

/**
 * In-memory stand-in for the Redis features RedisBackplane uses (INCR+XADD
 * script, XREAD BLOCK, XREVRANGE), shared by every client it creates so
 * several "replicas" can talk through it. `outage(ms)` makes every client
 * fail like a dropped connection, to exercise reconnect handling.
 */
export class FakeRedisBroker {
  private readonly entries: Array<[string, string[]]> = [];
  private seq = 0;
  private idCounter = 0;
  private downUntil = 0;
  private readonly waiters = new Set<() => void>();
  private readonly failPending = new Set<(err: Error) => void>();

  outage(ms: number): void {
    this.downUntil = Date.now() + ms;
    for (const fail of this.failPending) fail(new Error("Connection is closed."));
    this.failPending.clear();
  }

  client(): RedisLike {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- closures below outlive `this` binding
    const broker = this;
    const guard = () => {
      if (Date.now() < broker.downUntil) throw new Error("Connection is closed.");
    };
    return {
      async eval(_script, _numKeys, _seqKey, _streamKey, _maxLen, payload) {
        guard();
        const seq = ++broker.seq;
        broker.entries.push([`${++broker.idCounter}-0`, ["seq", String(seq), "event", String(payload)]]);
        for (const wake of broker.waiters) wake();
        return seq;
      },
      async xrevrange() {
        guard();
        const last = broker.entries[broker.entries.length - 1];
        return last ? [last] : [];
      },
      async xread(...args) {
        guard();
        const lastId = String(args[args.length - 1]);
        const blockMs = Number(args[args.indexOf("BLOCK") + 1]);
        const after = () => broker.entries.filter(([id]) => Number(id.split("-")[0]) > Number(lastId.split("-")[0]));
        const ready = after();
        if (ready.length) return [["stream", ready]];
        return new Promise((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            broker.waiters.delete(done);
            broker.failPending.delete(fail);
            const next = after();
            resolve(next.length ? [["stream", next]] : null);
          };
          const fail = (err: Error) => {
            clearTimeout(timer);
            broker.waiters.delete(done);
            reject(err);
          };
          const timer = setTimeout(done, blockMs);
          broker.waiters.add(done);
          broker.failPending.add(fail);
        });
      },
      disconnect() {
        /* no-op */
      },
    };
  }
}
