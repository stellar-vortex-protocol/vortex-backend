import type { WebSocket } from "ws";

/**
 * Encoding format negotiated per WebSocket connection (Activity 1).
 */
export type EncodingFormat = "json" | "msgpack";

/** Classic token bucket: `ratePerSec` sustained, up to `burst` at once. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Consumes one token; false when the bucket is empty. */
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Client IP for per-IP limits. With `trustedHops = 0` the socket address is
 * used and X-Forwarded-For is ignored (clients cannot spoof it). With N
 * trusted proxies, the address N entries from the right of
 * `X-Forwarded-For, remoteAddress` is the one the outermost trusted proxy saw.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string {
  const socketIp = remoteAddress ?? "unknown";
  if (trustedHops <= 0 || !forwardedFor) return socketIp;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const chain = [...header.split(",").map((s) => s.trim()).filter(Boolean), socketIp];
  return chain[Math.max(0, chain.length - 1 - trustedHops)];
}

export interface OutboundLimits {
  queueMax: number;
  bufferBytes: number;
  policy: "drop_oldest" | "disconnect";
}

export type OutboundResult = "sent" | "queued" | "dropped_oldest" | "disconnected";

/**
 * Per-connection state (issue #455): identity, inbound token bucket and a
 * bounded outbound queue.
 *
 * Messages go straight to the socket while `bufferedAmount` is below
 * `bufferBytes`; above it they wait in a queue of at most `queueMax`
 * messages, flushed from the `send` callbacks as the socket drains. When the
 * queue is full the policy either drops the oldest queued message or
 * terminates the connection — so a slow consumer costs at most
 * `bufferBytes + queueMax` messages of memory.
 */
export class ConnectionState {
  readonly bucket: TokenBucket;
  violations = 0;
  /** Authenticated solver address (signature or JWT), if any. */
  identity: string | null = null;
  /** Encoding format negotiated during handshake (Activity 1). */
  encoding: EncodingFormat = "json";
  private readonly queue: Array<string | Uint8Array> = [];
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    readonly ip: string,
    rate: { perSec: number; burst: number },
    private readonly limits: OutboundLimits,
  ) {
    this.bucket = new TokenBucket(rate.perSec, rate.burst);
  }

  queued(): number {
    return this.queue.length;
  }

  send(payload: string | Uint8Array): OutboundResult {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return "sent";
    if (this.queue.length === 0 && this.socket.bufferedAmount < this.limits.bufferBytes) {
      this.write(payload);
      return "sent";
    }
    this.queue.push(payload);
    if (this.queue.length <= this.limits.queueMax) return "queued";
    if (this.limits.policy === "disconnect") {
      this.close();
      this.socket.terminate();
      return "disconnected";
    }
    this.queue.shift();
    return "dropped_oldest";
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  private write(payload: string | Uint8Array) {
    this.socket.send(payload, () => this.flush());
  }

  private flush() {
    while (
      !this.closed &&
      this.queue.length > 0 &&
      this.socket.readyState === this.socket.OPEN &&
      this.socket.bufferedAmount < this.limits.bufferBytes
    ) {
      this.write(this.queue.shift()!);
    }
  }
}
