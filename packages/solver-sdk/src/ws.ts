import { EventEmitter } from "node:events";
import WebSocket from "ws";

/** Server → client frames (see src/intents/intents.gateway.ts). */
export type IntentEvent = {
  seq: number;
  type: "intent_created" | "intent_accepted" | "intent_filled" | "intent_cancelled" | "intent_expired" | "intent_slashed" | "auction_price" | string;
  intentId?: string;
  intent?: Record<string, unknown>;
  currentDstAmount?: string;
  timestamp?: number;
  [key: string]: unknown;
};

export interface VortexWsEvents {
  event: [IntentEvent];
  open: [];
  close: [{ code: number; reason: string }];
  /** The server can no longer replay the gap; re-fetch state over REST. */
  resync_required: [{ fromSeq: number; oldestAvailableSeq: number }];
  auth_ok: [{ method?: string }];
  auth_error: [{ reason: string }];
  rate_limited: [{ retryAfterMs?: number }];
  error: [Error];
}

export interface VortexWsOptions {
  /** e.g. ws://localhost:4000/ws */
  url: string;
  /** Solver JWT (SEP-10); sent as `?token=` on connect. */
  token?: string;
  /** Produces a signed `{ type: "auth" }` frame, sent after every (re)connect. */
  signAuth?: () => Record<string, unknown>;
  /** Optional chain filter re-applied after every reconnect. */
  chains?: string[];
  /** Resume after this sequence number on the first connect (e.g. persisted). */
  resumeFrom?: number;
  reconnect?: { initialMs?: number; maxMs?: number };
}

type Frame = Record<string, unknown> & { type?: string; seq?: number };

/**
 * Typed WS client with auto-reconnect and replay (issue #446).
 *
 * Tracks the last delivered `seq`; after a reconnect (or when it sees a gap)
 * it sends `{ type: "replay", fromSeq }`, drops duplicates, and emits
 * `event` strictly in ascending `seq` order. When the gap is older than the
 * server's replay buffer it emits `resync_required`.
 */
export class VortexWsClient extends EventEmitter<VortexWsEvents> {
  private ws: WebSocket | null = null;
  private lastSeq: number;
  private replaying = false;
  private stopped = false;
  private delay: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: VortexWsOptions) {
    super();
    this.lastSeq = opts.resumeFrom ?? -1;
    this.delay = opts.reconnect?.initialMs ?? 500;
  }

  /** Highest `seq` delivered so far (persist it to resume after a restart). */
  get position(): number {
    return this.lastSeq;
  }

  connect(): void {
    this.stopped = false;
    const url = this.opts.token ? `${this.opts.url}?token=${encodeURIComponent(this.opts.token)}` : this.opts.url;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.delay = this.opts.reconnect?.initialMs ?? 500;
      if (this.opts.signAuth) ws.send(JSON.stringify(this.opts.signAuth()));
      if (this.opts.chains) ws.send(JSON.stringify({ type: "subscribe", chains: this.opts.chains }));
      this.emit("open");
    });
    ws.on("message", (data) => this.onFrame(JSON.parse(data.toString()) as Frame));
    ws.on("error", (err) => this.emit("error", err));
    ws.on("close", (code, reason) => {
      this.emit("close", { code, reason: reason.toString() });
      this.ws = null;
      this.replaying = false;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private scheduleReconnect() {
    this.timer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.opts.reconnect?.maxMs ?? 15_000);
  }

  private requestReplay() {
    if (this.replaying || this.lastSeq < 0) return;
    this.replaying = true;
    this.ws?.send(JSON.stringify({ type: "replay", fromSeq: this.lastSeq }));
  }

  private onFrame(frame: Frame) {
    switch (frame.type) {
      case "connected":
        if (this.lastSeq < 0) this.lastSeq = Number(frame.seq ?? 0);
        else if (Number(frame.seq) > this.lastSeq) this.requestReplay();
        return;
      case "replay_start":
      case "snapshot":
      case "eligible_snapshot":
      case "subscribed":
        return;
      case "replay_end":
        this.replaying = false;
        return;
      case "replay_too_old":
        this.replaying = false;
        this.emit("resync_required", {
          fromSeq: Number(frame.fromSeq),
          oldestAvailableSeq: Number(frame.oldestAvailableSeq),
        });
        this.lastSeq = Number(frame.oldestAvailableSeq) - 1;
        return;
      case "auth_ok":
        this.emit("auth_ok", { method: frame.method as string | undefined });
        return;
      case "auth_error":
        this.emit("auth_error", { reason: String(frame.reason) });
        return;
      case "rate_limited":
        this.emit("rate_limited", { retryAfterMs: frame.retryAfterMs as number | undefined });
        return;
    }
    if (typeof frame.seq !== "number") return;
    if (frame.seq <= this.lastSeq) return; // duplicate (live + replay overlap)
    if (this.lastSeq >= 0 && frame.seq > this.lastSeq + 1 && !this.replaying) {
      // Gap: missed events (e.g. dropped as a slow consumer) — fetch them first.
      this.requestReplay();
      return;
    }
    if (this.replaying && frame.seq > this.lastSeq + 1) return; // wait for the replayed ones
    this.lastSeq = frame.seq;
    this.emit("event", frame as IntentEvent);
  }
}
