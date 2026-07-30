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

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly subscribers = new Set<WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private heartbeatTimer: any;

  constructor(private readonly intentsService: IntentsService) {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  handleConnection(client: WebSocket) {
    this.subscribers.add(client);
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

    client.send(JSON.stringify({ type: "connected", message: "Vortex intent stream" }));

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open }));
  }

  handleDisconnect(client: WebSocket) {
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

  broadcast(event: { type: string; [key: string]: unknown }) {
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

  private heartbeat() {
    for (const client of this.subscribers) {
      if (this.alive.get(client) === false) {
        client.terminate();
        this.subscribers.delete(client);
        continue;
      }

      this.alive.set(client, false);
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
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
