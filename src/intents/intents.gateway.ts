import { OnModuleDestroy } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { logger } from "../common/logger";

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
@WebSocketGateway({ path: "/ws" })
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly subscribers = new Set<WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private heartbeatTimer: any;
  private nextSeq = 1;

  constructor(private readonly intentsService: IntentsService) {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    logger.info("ws heartbeat started");
  }

  handleConnection(client: WebSocket) {
    this.subscribers.add(client);
    this.alive.set(client, true);

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
    logger.info(`ws client disconnected (subscribers=${this.subscribers.size})`);
  }

  broadcast(event: { type: string; [key: string]: unknown }) {
    logger.debug(`ws broadcast type=${event.type} subscribers=${this.subscribers.size}`);
    const payload = JSON.stringify(event);
    for (const client of this.subscribers) {
      if (client.readyState !== WebSocket.OPEN) continue;
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

  /** Returns the current number of active WebSocket subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private heartbeat() {
    for (const client of this.subscribers) {
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
    for (const client of this.subscribers) {
      client.close(1001, "Server shutting down");
    }
    this.subscribers.clear();
  }
}
