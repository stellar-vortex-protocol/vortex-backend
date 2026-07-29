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

  handleConnection(client: WebSocket) {
    const solverAddress = this.getSolverAddress(client);
    this.subscribers.add(client);
    if (solverAddress) {
      this.solverConnections.set(client, solverAddress);
      this.solversService.markLive(solverAddress);
    }
    client.on("error", () => this.subscribers.delete(client));

    client.send(
      JSON.stringify({ type: "connected", message: "Vortex intent stream" }),
    );

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open }));
  }

  handleDisconnect(client: WebSocket) {
    const solverAddress = this.solverConnections.get(client);
    if (solverAddress) {
      this.solversService.markOffline(solverAddress);
    }
    this.solverConnections.delete(client);
    this.subscribers.delete(client);
  }

  private getSolverAddress(client: WebSocket): string | undefined {
    const match = /(?:^|&)solver=([^&]+)/.exec(client.url ?? "");
    return match ? decodeURIComponent(match[1]) : undefined;
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
