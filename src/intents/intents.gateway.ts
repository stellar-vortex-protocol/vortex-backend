import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";

interface SubscriberFilter {
  chains?: string[];
}

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly subscribers = new Map<WebSocket, SubscriberFilter>();

  constructor(private readonly intentsService: IntentsService) {}

  handleConnection(client: WebSocket) {
    this.subscribers.set(client, {});
    client.on("error", () => this.subscribers.delete(client));
    client.on("message", (raw) => this.handleMessage(client, raw));

    client.send(JSON.stringify({ type: "connected", message: "Vortex intent stream" }));

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open }));
  }

  handleDisconnect(client: WebSocket) {
    this.subscribers.delete(client);
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