import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { SolversService } from "../solvers/solvers.service";

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly subscribers = new Set<WebSocket>();
  private readonly solverConnections = new Map<WebSocket, string>();

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
  ) {}
import { OnModuleDestroy } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { AppConfig } from "../config/configuration";

const HEARTBEAT_INTERVAL_MS = 30_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const setInterval: (fn: (...args: any[]) => void, ms: number) => any;
declare const clearInterval: (handle: any) => void;
/* eslint-enable @typescript-eslint/no-explicit-any */

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

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly subscribers = new Set<WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private heartbeatTimer: any;

  constructor(private readonly intentsService: IntentsService) {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    logger.info("ws heartbeat started");
  }

  handleConnection(client: WebSocket) {
    const solverAddress = this.getSolverAddress(client);
    this.subscribers.add(client);
    if (solverAddress) {
      this.solverConnections.set(client, solverAddress);
      this.solversService.markLive(solverAddress);
    }
    this.alive.set(client, true);

    client.on("pong", () => {
      this.alive.set(client, true);
    });

interface SubscriberFilter {
  chains?: string[];
}

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly subscribers = new Map<WebSocket, SubscriberFilter>();
/**
 * Authentication / access-control decision (issue #49)
 * ───────────────────────────────────────────────────────
 * The intent feed is intentionally PUBLIC and READ-ONLY.  Any client may
 * connect and receive real-time intent events without presenting credentials.
 * This mirrors the design of public DEX order-book streams (e.g. dYdX, Stellar
 * Horizon) where transparency is a protocol property.
 *
 * Solver bots submit intents and accept/fill them through the authenticated
 * REST API (POST /api/v1/intents, POST /api/v1/intents/:id/accept, etc.).
 * The WS gateway never accepts writes, so there is no privileged action to
 * protect here.
 *
 * If a private/authenticated stream is needed in the future (e.g. per-solver
 * private fills), add a separate gateway path (e.g. /ws/solver) and apply
 * a NestJS WsGuard there.
 */
@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(IntentsGateway.name);
  private readonly subscribers = new Set<WebSocket>();
  /** Configured via WS_MAX_CONNECTIONS env var (default 1000, 0 = unlimited). */
  private readonly maxConnections: number;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {
    this.maxConnections = this.configService.get("wsMaxConnections", { infer: true });
  }

  /**
   * Returns the current number of active WebSocket subscribers.
   * Exposed for metrics / health checks (issue #50 / #65).
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  handleConnection(client: WebSocket) {
    this.subscribers.set(client, {});
    client.on("error", () => this.subscribers.delete(client));
    client.on("message", (raw) => this.handleMessage(client, raw));
    // ── Max-connections guard (issue #50) ────────────────────────────────────
    // Reject the connection before adding it to the subscriber set so the cap
    // is never exceeded.  Close code 1013 = "Try Again Later" (RFC 6455).
    if (this.maxConnections > 0 && this.subscribers.size >= this.maxConnections) {
      this.logger.warn(
        `WS connection rejected: subscriber limit reached (${this.maxConnections})`,
      );
      client.close(1013, "Server at capacity — try again later");
      return;
    }

    this.subscribers.add(client);
    this.logger.debug(`WS client connected — active subscribers: ${this.subscribers.size}`);
    client.on("error", () => {
      this.subscribers.delete(client);
      this.logger.debug(`WS client error/drop — active subscribers: ${this.subscribers.size}`);
    });

    client.send(
      JSON.stringify({ type: "connected", message: "Vortex intent stream" }),
    logger.info(`ws client connected (subscribers=${this.subscribers.size})`);

    const currentSeq = this.nextSeq - 1;

    client.send(
      JSON.stringify({
        type: "connected",
        message: "Vortex intent stream",
        seq: currentSeq,
      }),
    );

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open, seq: currentSeq }));

    this.logger.debug(`client connected; subscribers=${this.subscribers.size} seq=${currentSeq}`);
  }

  handleDisconnect(client: WebSocket) {
    const solverAddress = this.solverConnections.get(client);
    if (solverAddress) {
      this.solversService.markOffline(solverAddress);
    }
    this.solverConnections.delete(client);
    this.subscribers.delete(client);
    this.logger.debug(`WS client disconnected — active subscribers: ${this.subscribers.size}`);
  }

  private handleMessage(client: WebSocket, raw: Buffer) {
    let message: { type?: string; chains?: string[] };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "subscribe") {
      const filter: SubscriberFilter = {};
      if (message.chains && message.chains.length > 0) {
        filter.chains = message.chains;
      }
      this.subscribers.set(client, filter);
      client.send(JSON.stringify({ type: "subscribed", filter }));
    }
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private getSolverAddress(client: WebSocket): string | undefined {
    const match = /(?:^|&)solver=([^&]+)/.exec(client.url ?? "");
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  broadcast(event: { type: string; [key: string]: unknown }) {
    logger.debug(`ws broadcast type=${event.type} subscribers=${this.subscribers.size}`);
    const payload = JSON.stringify(event);
    for (const [client, filter] of this.subscribers) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (filter.chains && filter.chains.length > 0) {
        const eventChain = this.getEventChain(event);
        if (eventChain && !filter.chains.includes(eventChain)) continue;
      }
      client.send(payload);
    }
  }

  getAliveCount(): number {
    let count = 0;
    for (const client of this.subscribers) {
      if (this.alive.get(client) === true) count++;
    }
    return count;
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  private heartbeat() {
    for (const client of this.subscribers) {
      if (this.alive.get(client) === false) {
        client.terminate();
        this.subscribers.delete(client);
        logger.debug(`ws heartbeat terminated dead client (subscribers=${this.subscribers.size})`);
        continue;
      }

      this.alive.set(client, false);
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
    span.setAttribute("subscribers.sent", sent);
    span.end();
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }
}
  private getEventChain(event: { type: string; [key: string]: unknown }): string | null {
    if (event.type === "intent_created" && event.intent) {
      return (event.intent as { srcChain?: string }).srcChain ?? null;
    }
    if (
      (event.type === "intent_filled" ||
        event.type === "intent_accepted" ||
        event.type === "intent_cancelled" ||
        event.type === "intent_expired") &&
      event.intentId
    ) {
      const intent = this.intentsService.get(event.intentId as string);
      return intent?.srcChain ?? null;
    }
    return null;
  }
}
