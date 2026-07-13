import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly subscribers = new Set<WebSocket>();

  constructor(private readonly intentsService: IntentsService) {}

  handleConnection(client: WebSocket) {
    this.subscribers.add(client);
    client.on("error", () => this.subscribers.delete(client));

    client.send(JSON.stringify({ type: "connected", message: "Vortex intent stream" }));

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open }));
  }

  handleDisconnect(client: WebSocket) {
    this.subscribers.delete(client);
  }

  broadcast(event: { type: string; [key: string]: unknown }) {
    const payload = JSON.stringify(event);
    for (const client of this.subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
