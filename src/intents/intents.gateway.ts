import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("vortex-backend", "0.1.0");

@WebSocketGateway({ path: "/ws" })
export class IntentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly subscribers = new Set<WebSocket>();

  constructor(private readonly intentsService: IntentsService) {}

  handleConnection(client: WebSocket) {
    const span = tracer.startSpan("ws.connect");
    this.subscribers.add(client);
    client.on("error", () => {
      this.subscribers.delete(client);
      span.recordException(new Error("WebSocket client error"));
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });

    client.send(JSON.stringify({ type: "connected", message: "Vortex intent stream" }));
    span.addEvent("connection_acknowledged");

    const open = this.intentsService.getByState("open").slice(0, 20);
    client.send(JSON.stringify({ type: "snapshot", intents: open }));
    span.addEvent("snapshot_sent", { count: open.length });
    span.end();
  }

  handleDisconnect(client: WebSocket) {
    const span = tracer.startSpan("ws.disconnect");
    this.subscribers.delete(client);
    span.end();
  }

  broadcast(event: { type: string; [key: string]: unknown }) {
    const span = tracer.startSpan(`ws.broadcast.${event.type}`);
    span.setAttribute("event.type", event.type);
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const client of this.subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent++;
      }
    }
    span.setAttribute("subscribers.sent", sent);
    span.end();
  }
}
