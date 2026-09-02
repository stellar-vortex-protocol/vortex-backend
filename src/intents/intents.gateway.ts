import { OnModuleDestroy } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { SolversService } from "../solvers/solvers.service";
import { logger } from "../common/logger";
import { SUPPORTED_CHAINS, SupportedChain } from "./intents.types";

const HEARTBEAT_INTERVAL_MS = 30_000;

/** How many sequenced events to keep in the replay buffer. */
const REPLAY_BUFFER_SIZE = 500;

export interface SequencedEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Fixed-size ring buffer that retains the last `capacity` events so
 * reconnecting clients can request a replay from a known sequence number.
 */
export class EventRingBuffer {
  private readonly buf: SequencedEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = REPLAY_BUFFER_SIZE) {
    this.capacity = capacity;
  }

  push(event: SequencedEvent): void {
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
    }
    this.buf.push(event);
  }

  /**
   * Return all buffered events whose seq is strictly greater than `fromSeq`.
   * Returns an empty array when `fromSeq` is older than the earliest buffered
   * event (the caller should request a fresh snapshot instead).
   */
  since(fromSeq: number): SequencedEvent[] {
    return this.buf.filter((e) => e.seq > fromSeq);
  }

  /** Lowest seq still in the buffer, or -1 when empty. */
  oldestSeq(): number {
    return this.buf.length === 0 ? -1 : this.buf[0].seq;
  }

  /** Highest seq in the buffer, or 0 when empty. */
  latestSeq(): number {
    return this.buf.length === 0 ? 0 : this.buf[this.buf.length - 1].seq;
  }

  size(): number {
    return this.buf.length;
  }
}

/**
 * Authentication / access-control decision (issue #49)
 * ───────────────────────────────────────────────────────
 * The intent feed is intentionally PUBLIC and READ-ONLY. Any client may
 * connect and receive real-time intent events without presenting credentials.
 *
 * Solver bots submit intents and accept/fill them through the authenticated
 * REST API. The WS gateway never accepts writes, so there is no privileged
 * action to protect here.
 */
type SubscriberFilter = Set<SupportedChain> | null;

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly subscribers = new Map<WebSocket, SubscriberFilter>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly authenticatedSolver = new WeakMap<WebSocket, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private heartbeatTimer: any;
  private nextSeq = 1;
  private readonly backplane: null | {
    publish: (event: Record<string, unknown>) => void;
    subscribe: (handler: (event: Record<string, unknown>) => void) => void;
  } = null;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
  ) {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.backplane = this.createBackplane();
    if (this.backplane) {
      this.backplane.subscribe((event) => {
        const type = typeof event.type === "string" ? event.type : "";
        if (!type) return;
        this.dispatchRemoteEvent(event as Record<string, unknown>);
      });
    }
    logger.info("ws heartbeat started");
  }

  private createBackplane(): null | {
    publish: (event: Record<string, unknown>) => void;
    subscribe: (handler: (event: Record<string, unknown>) => void) => void;
  } {
    const mode = (process.env.WS_BACKPLANE ?? "memory").toLowerCase();
    if (mode !== "redis") return null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const redis = require("redis");
      if (!redis?.createClient) {
        logger.warn("WS_BACKPLANE=redis but the redis package is not available; falling back to memory");
        return null;
      }

      const client = redis.createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
      const channel = "vortex:intents:ws";
      const pub = client;
      const sub = client.duplicate();

      void sub.connect();
      void sub.subscribe(channel, (message: string) => {
        try {
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event && typeof event === "object") {
            this.dispatchRemoteEvent(event);
          }
        } catch {
          // Ignore malformed backplane payloads.
        }
      });

      return {
        publish: (event: Record<string, unknown>) => {
          void pub.publish(channel, JSON.stringify(event));
        },
        subscribe: (handler: (event: Record<string, unknown>) => void) => {
          void sub.subscribe(channel, (message: string) => {
            try {
              const event = JSON.parse(message) as Record<string, unknown>;
              handler(event);
            } catch {
              // Ignore malformed backplane payloads.
            }
          });
        },
      };
    } catch {
      logger.warn("WS_BACKPLANE=redis but the redis package is not available; falling back to memory");
      return null;
    }
  }

  private static isSupportedChain(value: unknown): value is SupportedChain {
    return typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value);
  }

  private static resolveFilter(chains: unknown): SubscriberFilter {
    if (!Array.isArray(chains) || chains.length === 0) {
      return null;
    }

    const normalized = new Set<SupportedChain>();
    for (const chain of chains) {
      if (IntentsGateway.isSupportedChain(chain)) {
        normalized.add(chain);
      }
    }

    return normalized.size > 0 ? normalized : null;
  }

  private handleMessage(client: WebSocket, raw: unknown) {
    try {
      const text = typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString() : String(raw);
      const message = JSON.parse(text) as { type?: string; chains?: unknown };
      if (message.type !== "subscribe") return;

      const filter = IntentsGateway.resolveFilter(message.chains);
      this.subscribers.set(client, filter);

      client.send(
        JSON.stringify({
          type: "subscribed",
          filter: { chains: filter ? [...filter] : [...SUPPORTED_CHAINS] },
          seq: this.nextSeq - 1,
        }),
      );
    } catch {
      // Ignore malformed WS frames; the client can reconnect or retry.
    }
  }

  private getEventChain(event: { type: string; [key: string]: unknown }): SupportedChain | null {
    const intent = (event as { intent?: { srcChain?: unknown } }).intent;
    if (intent && typeof intent.srcChain === "string" && IntentsGateway.isSupportedChain(intent.srcChain)) {
      return intent.srcChain;
    }

    const srcChain = (event as { srcChain?: unknown }).srcChain;
    if (typeof srcChain === "string" && IntentsGateway.isSupportedChain(srcChain)) {
      return srcChain;
    }

    return null;
  }

  private deliverToMatchingSubscribers(payload: string, chain: SupportedChain | null) {
    for (const [client, filter] of this.subscribers.entries()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (chain !== null && filter && !filter.has(chain)) continue;
      client.send(payload);
    }
  }

  private dispatchRemoteEvent(event: Record<string, unknown>) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!type || type === "connected" || type === "snapshot" || type === "subscribed") return;

    const payload = JSON.stringify(event);
    const chain = this.getEventChain(event as { type: string; [key: string]: unknown });
    this.deliverToMatchingSubscribers(payload, chain);
  }

  handleConnection(client: WebSocket) {
    this.subscribers.set(client, null);
    this.alive.set(client, true);

    client.on("message", (raw) => this.handleMessage(client, raw));

    client.on("pong", () => {
      this.alive.set(client, true);
    });

    client.on("message", (raw) => {
      void this.handleMessage(client, raw);
    });

    client.on("error", () => {
      this.subscribers.delete(client);
      logger.debug(
        `ws client error/drop — active subscribers: ${this.subscribers.size}`,
      );
    });

    const currentSeq = this.nextSeq - 1;

    client.send(
      JSON.stringify({
        type: "connected",
        message: "Vortex intent stream",
        seq: currentSeq,
      }),
    );

    // Send the initial snapshot asynchronously — the client receives it
    // immediately after the "connected" message.
    Promise.resolve(this.intentsService.getByState("open"))
      .then((open) => {
        client.send(JSON.stringify({ type: "snapshot", intents: open.slice(0, 20), seq: currentSeq }));
      })
      .catch(() => {
        /* snapshot failure is non-fatal — client can re-fetch via REST */
      });

    logger.info(`ws client connected (subscribers=${this.subscribers.size})`);
  }

  handleDisconnect(client: WebSocket) {
    this.subscribers.delete(client);
    this.authenticatedSolver.delete(client);
    logger.info(`ws client disconnected (subscribers=${this.subscribers.size})`);
  }

  private async handleMessage(client: WebSocket, raw: unknown) {
    try {
      const serialized = Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : typeof raw === "string"
          ? raw
          : String(raw);
      const payload = JSON.parse(serialized);
      if (!payload || typeof payload !== "object") return;

      switch (payload.type) {
        case "auth": {
          await this.handleAuth(client, payload);
          return;
        }
        default:
          return;
      }
    } catch {
      client.send(JSON.stringify({ type: "auth_error", reason: "Invalid WS message" }));
    }
  }

  private async handleAuth(client: WebSocket, payload: Record<string, unknown>) {
    const solver = typeof payload.solver === "string" ? payload.solver : "";
    const timestamp = payload.timestamp;
    const signature = typeof payload.signature === "string" ? payload.signature : "";

    if (!solver || !signature || typeof timestamp !== "number") {
      client.send(JSON.stringify({ type: "auth_error", reason: "auth payload requires solver, timestamp, and signature" }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - timestamp);
    if (skew > 300) {
      client.send(JSON.stringify({ type: "auth_error", reason: "stale or future auth timestamp" }));
      return;
    }

    const solverRecord = await this.solversService.get(solver);
    if (!solverRecord || !solverRecord.isActive) {
      client.send(JSON.stringify({ type: "auth_error", reason: "solver not registered or inactive" }));
      return;
    }

    try {
      verifyStellarSignature(solver, buildWsAuthMessage(solver, timestamp), signature);
      this.authenticatedSolver.set(client, solver);
      client.send(JSON.stringify({ type: "auth_ok" }));
    } catch {
      client.send(JSON.stringify({ type: "auth_error", reason: "invalid solver signature" }));
    }
  }

  broadcast(event: { type: string; [key: string]: unknown }) {
    const seqEvent = { ...event, seq: this.nextSeq };
    this.nextSeq += 1;
    logger.debug(`ws broadcast type=${event.type} subscribers=${this.subscribers.size}`);
    const payload = JSON.stringify(seqEvent);
    const chain = this.getEventChain(seqEvent);

    if (this.backplane) {
      this.backplane.publish(seqEvent as Record<string, unknown>);
    }

    if (chain) {
      this.deliverToMatchingSubscribers(payload, chain);
      return;
    }

    if (typeof event.intentId === "string") {
      void this.intentsService
        .get(event.intentId)
        .then((intent) => {
          if (!intent) {
            this.deliverToMatchingSubscribers(payload, null);
            return;
          }
          this.deliverToMatchingSubscribers(payload, intent.srcChain);
        })
        .catch(() => {
          this.deliverToMatchingSubscribers(payload, null);
        });
      return;
    }

    this.deliverToMatchingSubscribers(payload, null);
  }

  getAliveCount(): number {
    let count = 0;
    for (const client of this.subscribers.keys()) {
      if (this.alive.get(client) === true) count++;
    }
    return count;
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /** Returns the current number of active WebSocket subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private heartbeat() {
    for (const [client] of this.subscribers.entries()) {
      if (this.alive.get(client) === false) {
        client.terminate();
        this.subscribers.delete(client);
        logger.debug(
          `ws heartbeat terminated dead client (subscribers=${this.subscribers.size})`,
        );
        continue;
      }

      this.alive.set(client, false);
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.subscribers.keys()) {
      client.close(1001, "Server shutting down");
    }
    this.subscribers.clear();
  }
}
