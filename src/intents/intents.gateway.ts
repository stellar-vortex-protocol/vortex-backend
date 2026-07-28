import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";

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
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(IntentsGateway.name);
  private readonly subscribers = new Set<WebSocket>();

  /** Monotonically increasing sequence counter — never resets while the process is alive. */
  private nextSeq = 1;

  /** Sliding window of recent events for replay. */
  readonly replayBuffer = new EventRingBuffer(REPLAY_BUFFER_SIZE);

  constructor(private readonly intentsService: IntentsService) {}

  handleConnection(client: WebSocket) {
    this.subscribers.add(client);
    client.on("error", () => this.subscribers.delete(client));

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
    this.subscribers.delete(client);
    this.logger.debug(`client disconnected; subscribers=${this.subscribers.size}`);
  }

  /**
   * Clients send `{ event: "replay", data: { fromSeq: number } }` after
   * reconnecting to receive any events they missed.
   *
   * If `fromSeq` is older than the oldest buffered event the server replies
   * with a `replay_too_old` message so the client knows to fall back to the
   * full snapshot.
   */
  @SubscribeMessage("replay")
  handleReplay(
    @MessageBody() data: { fromSeq: number },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const fromSeq = Number(data?.fromSeq ?? 0);
    const oldest = this.replayBuffer.oldestSeq();

    if (oldest !== -1 && fromSeq < oldest) {
      // The gap is too large; tell the client to take a fresh snapshot.
      client.send(
        JSON.stringify({
          type: "replay_too_old",
          fromSeq,
          oldestAvailableSeq: oldest,
          message: "Requested sequence is no longer in the replay buffer. Request a fresh snapshot.",
        }),
      );
      this.logger.warn(`replay_too_old requested fromSeq=${fromSeq} oldest=${oldest}`);
      return;
    }

    const missed = this.replayBuffer.since(fromSeq);
    client.send(
      JSON.stringify({
        type: "replay_start",
        fromSeq,
        count: missed.length,
      }),
    );

    for (const event of missed) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
      }
    }

    client.send(JSON.stringify({ type: "replay_end", fromSeq, count: missed.length }));
    this.logger.debug(`replay sent fromSeq=${fromSeq} count=${missed.length}`);
  }

  /**
   * Broadcast an event to all open subscribers.
   * Stamps the event with a monotonic `seq` number and stores it in the replay
   * buffer before fanning out.
   */
  broadcast(event: { type: string; [key: string]: unknown }): void {
    const sequenced: SequencedEvent = { ...event, seq: this.nextSeq++ };
    this.replayBuffer.push(sequenced);

    const payload = JSON.stringify(sequenced);
    for (const client of this.subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
