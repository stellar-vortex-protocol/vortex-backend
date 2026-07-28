import { OnModuleDestroy } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { logger } from "../common/logger";

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
    logger.info("ws heartbeat started");
  }

  handleConnection(client: WebSocket) {
    this.subscribers.add(client);
    this.alive.set(client, true);

    client.on("pong", () => {
      this.alive.set(client, true);
    });

    client.on("error", () => this.subscribers.delete(client));

    logger.info(`ws client connected (subscribers=${this.subscribers.size})`);

    client.send(JSON.stringify({ type: "connected", message: "Vortex intent stream" }));

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open }));
  }

  handleDisconnect(client: WebSocket) {
    this.subscribers.delete(client);
    logger.info(`ws client disconnected (subscribers=${this.subscribers.size})`);
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  broadcast(event: { type: string; [key: string]: unknown }) {
    logger.debug(`ws broadcast type=${event.type} subscribers=${this.subscribers.size}`);
    const payload = JSON.stringify(event);
    for (const client of this.subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
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
  }
}
