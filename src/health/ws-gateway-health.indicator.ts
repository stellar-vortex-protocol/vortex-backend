import { Injectable } from "@nestjs/common";
import { IntentsGateway } from "../intents/intents.gateway";
import { HealthIndicator, IndicatorResult, ServiceRole } from "./health-indicator.registry";

/**
 * Health indicator for the WebSocket gateway (issue #511).
 *
 * Tracks draining state for graceful shutdown:
 * - During drain, readiness returns "down" so the load balancer stops routing
 *   new connections to this replica
 * - Existing connections receive `server_draining` and close gradually
 */
@Injectable()
export class WsGatewayHealthIndicator implements HealthIndicator {
  readonly name = "ws_gateway";
  /** Critical for the `ws` role: a draining gateway must not receive traffic. */
  readonly criticalFor: ServiceRole[] = ["ws"];

  constructor(private readonly gateway: IntentsGateway) {}

  async check(): Promise<IndicatorResult> {
    const draining = this.gateway.isDraining();
    const subscribers = this.gateway.subscriberCount;

    return draining
      ? { status: "down", details: { draining: true, subscribers } }
      : { status: "up", details: { draining: false, subscribers } };
  }
}
