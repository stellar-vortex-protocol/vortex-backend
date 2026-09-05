import { OnModuleDestroy } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { SolversService } from "../solvers/solvers.service";
import { logger } from "../common/logger";
import { SUPPORTED_CHAINS, SupportedChain } from "./intents.types";
import { verifyStellarSignature, buildWsAuthMessage } from "../common/stellar-signature";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How many sequenced events to keep in the replay buffer.
 *
 * At typical broadcast volume (a few dozen events/minute in production),
 * 500 events covers many minutes of missed events — more than enough to
 * bridge a transient network blip or container restart without forcing a
 * full snapshot re-fetch. Increasing this beyond ~1 000 starts to add
 * non-trivial heap pressure for large event payloads; the current bound
 * is a deliberate memory vs. reconnect-gap tradeoff.
 */
const REPLAY_BUFFER_SIZE = 500;

export interface SequencedEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Per-subscriber chain filter. `chains: null` means "no filter set" — the
 * client receives the full unfiltered feed (backward-compatible default).
 */
interface SubscriberFilter {
  chains: Set<SupportedChain> | null;
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
@WebSocketGateway({ path: "/ws" })
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  /**
   * Map from WebSocket client to its per-connection subscription filter.
   * A filter with `chains: null` means the client receives all events
   * (the default when no `subscribe` message has been sent).
   */
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

  /** Ring buffer storing the last REPLAY_BUFFER_SIZE broadcast events. */
  private readonly ringBuffer = new EventRingBuffer(REPLAY_BUFFER_SIZE);

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

  private dispatchRemoteEvent(event: Record<string, unknown>) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!type || type === "connected" || type === "snapshot" || type === "subscribed") return;

    const payload = JSON.stringify(event);
    const chain = this.getEventChainSync(event as { type: string; [key: string]: unknown });
    this.deliverToMatchingSubscribers(payload, chain);
  }

  /**
   * Synchronous chain resolution for simple cases (used by dispatchRemoteEvent).
   * Reads srcChain directly from the event or its inlined intent object.
   */
  private getEventChainSync(event: { type: string; [key: string]: unknown }): SupportedChain | null {
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
    for (const [client, filter] of this.subscribers) {
      if (client.readyState !== WebSocket.OPEN) continue;

      // No filter set → full unfiltered feed (backward-compatible default).
      if (filter.chains === null) {
        client.send(payload);
        continue;
      }

      // Chain couldn't be resolved → deliver to everyone (safe default).
      if (chain === null) {
        client.send(payload);
        continue;
      }

      // Only send if the event's chain is in this subscriber's filter.
      if (filter.chains.has(chain)) {
        client.send(payload);
      }
    }
  }

  handleConnection(client: WebSocket) {
    this.subscribers.set(client, { chains: null });
    this.alive.set(client, true);

    client.on("message", (raw) => {
      void this.handleMessage(client, raw);
    });

    client.on("pong", () => {
      this.alive.set(client, true);
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

  /**
   * Handle a single incoming WebSocket message from a client.
   *
   * Supported message types:
   * - `{ type: "subscribe", chains: string[] }` — set a per-connection chain
   *   filter and respond with `{ type: "subscribed", filter: { chains } }`.
   * - `{ type: "replay", fromSeq: number }` — replay buffered events since
   *   `fromSeq`, wrapped in replay_start / replay_end frames.
   * - `{ type: "auth", solver, timestamp, signature }` — authenticate as a
   *   registered solver.
   *
   * Unknown types and malformed messages are silently ignored; they never
   * crash the connection.
   */
  private async handleMessage(client: WebSocket, raw: import("ws").RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      // Malformed JSON — ignore silently.
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;

    const msg = parsed as Record<string, unknown>;

    switch (msg.type) {
      case "subscribe":
        this.handleSubscribe(client, msg);
        break;
      case "replay":
        this.handleReplay(client, msg);
        break;
      case "auth":
        await this.handleAuth(client, msg);
        break;
      default:
        // Unknown message type — ignore, do not crash the connection.
        break;
    }
  }

  /**
   * Process a `{ type: "subscribe", chains: string[] }` message.
   *
   * Validates each chain value against `SUPPORTED_CHAINS` and stores only
   * the valid subset. A subscribe message with no valid chains is treated as
   * "subscribe to nothing" (the client will receive only chainless events).
   * An entirely missing or non-array `chains` field is rejected silently
   * without updating the existing filter.
   */
  private handleSubscribe(client: WebSocket, msg: Record<string, unknown>): void {
    if (!Array.isArray(msg.chains)) {
      logger.debug("ws subscribe ignored: chains field missing or not an array");
      return;
    }

    const validChains = (msg.chains as unknown[]).filter(
      (c): c is SupportedChain =>
        typeof c === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(c),
    );

    this.subscribers.set(client, { chains: new Set(validChains) });

    logger.debug(`ws client subscribed to chains: ${validChains.join(", ") || "(none)"}`);

    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "subscribed",
          filter: { chains: validChains },
        }),
      );
    }
  }

  /**
   * Process a `{ type: "replay", fromSeq: number }` message.
   *
   * If `fromSeq` falls within the buffer (i.e. `fromSeq >= oldestSeq - 1`),
   * the missed events are streamed back wrapped in `replay_start` /
   * `replay_end` frames. Otherwise, `replay_too_old` is returned so the
   * client knows it must fall back to a fresh snapshot via REST.
   */
  private handleReplay(client: WebSocket, msg: Record<string, unknown>): void {
    const fromSeq = typeof msg.fromSeq === "number" ? msg.fromSeq : null;
    if (fromSeq === null || !Number.isInteger(fromSeq) || fromSeq < 0) {
      logger.debug("ws replay ignored: fromSeq missing or invalid");
      return;
    }

    if (client.readyState !== WebSocket.OPEN) return;

    const oldest = this.ringBuffer.oldestSeq();

    // oldest === -1 means the buffer is empty — nothing to replay.
    // The check `fromSeq < oldest - 1` catches the case where the requested
    // seq has already been evicted from the ring buffer.
    if (oldest !== -1 && fromSeq < oldest - 1) {
      client.send(
        JSON.stringify({
          type: "replay_too_old",
          fromSeq,
          oldestAvailableSeq: oldest,
        }),
      );
      logger.debug(`ws replay_too_old: fromSeq=${fromSeq} oldestAvailable=${oldest}`);
      return;
    }

    const events = this.ringBuffer.since(fromSeq);

    client.send(
      JSON.stringify({
        type: "replay_start",
        fromSeq,
        count: events.length,
      }),
    );

    for (const event of events) {
      if (client.readyState !== WebSocket.OPEN) break;
      client.send(JSON.stringify(event));
    }

    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "replay_end",
          count: events.length,
        }),
      );
    }

    logger.debug(`ws replay complete: fromSeq=${fromSeq} count=${events.length}`);
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

  /**
   * Resolve the source chain for an event payload.
   *
   * - `intent_created`: the intent object is inlined in the event, so
   *   `srcChain` can be read directly without a service lookup.
   * - State-transition events (`intent_accepted`, `intent_filled`,
   *   `intent_cancelled`, `intent_expired`, `intent_slashed`): only the
   *   `intentId` is available, so the intent must be looked up to get its
   *   `srcChain`. This is async and returns `null` on any lookup failure.
   * - Everything else: returns `null` (event is delivered to all subscribers).
   */
  private async getEventChain(
    event: { type: string; [key: string]: unknown },
  ): Promise<SupportedChain | null> {
    if (event.type === "intent_created") {
      const intent = event.intent as { srcChain?: string } | undefined;
      const chain = intent?.srcChain;
      if (chain && (SUPPORTED_CHAINS as readonly string[]).includes(chain)) {
        return chain as SupportedChain;
      }
      return null;
    }

    const lookupTypes = new Set([
      "intent_accepted",
      "intent_filled",
      "intent_cancelled",
      "intent_expired",
      "intent_slashed",
    ]);

    if (lookupTypes.has(event.type)) {
      const intentId = typeof event.intentId === "string" ? event.intentId : null;
      if (!intentId) return null;

      try {
        const intent = await this.intentsService.get(intentId);
        if (intent && (SUPPORTED_CHAINS as readonly string[]).includes(intent.srcChain)) {
          return intent.srcChain as SupportedChain;
        }
      } catch {
        // Lookup failure is non-fatal — deliver to all subscribers.
      }
      return null;
    }

    return null;
  }

  /**
   * Assign a monotonically increasing sequence number, push the event into
   * the ring buffer, then deliver it to every subscriber whose chain filter
   * matches.
   *
   * Filter semantics:
   * - A subscriber with `chains === null` (never sent a subscribe message)
   *   receives all events — backward-compatible with read-only consumers.
   * - A subscriber with a non-null chain set receives the event only if the
   *   event's chain is in their set, or if the chain could not be resolved
   *   (null) — unchained events are always delivered to everyone.
   */
  async broadcast(event: { type: string; [key: string]: unknown }): Promise<void> {
    const seq = this.nextSeq++;
    const sequencedEvent: SequencedEvent = { ...event, seq };

    // Push into replay buffer before sending so a racing replay request
    // issued immediately after this broadcast still finds the event.
    this.ringBuffer.push(sequencedEvent);

    logger.debug(`ws broadcast type=${event.type} seq=${seq} subscribers=${this.subscribers.size}`);

    if (this.backplane) {
      this.backplane.publish(sequencedEvent as Record<string, unknown>);
    }

    // Resolve the chain once — shared across all subscriber checks.
    const eventChain = await this.getEventChain(event);

    const payload = JSON.stringify(sequencedEvent);
    this.deliverToMatchingSubscribers(payload, eventChain);
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
    for (const [client] of this.subscribers) {
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
    for (const [client] of this.subscribers) {
      client.close(1001, "Server shutting down");
    }
    this.subscribers.clear();
  }
}
