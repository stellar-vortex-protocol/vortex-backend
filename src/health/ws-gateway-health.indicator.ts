import { Injectable } from "@nestjs/common";
import { IntentsGateway } from "../intents/intents.gateway";
import { HealthIndicator, HealthResult } from "./health-indicator.registry";

/**
 * Health indicator for WebSocket gateway (Activity 2).
 * 
 * Tracks draining state for graceful shutdown:
 * - During drain, readiness returns "not_ready" so load balancer stops routing
 * - Existing connections receive server_draining and close gradually
 */
@Injectable()
export class WsGatewayHealthIndicator implements HealthIndicator {
  constructor(private readonly gateway: IntentsGateway) {}

  name(): string {
    return "ws_gateway";
  }

  critical(): boolean {
    return true; // Critical for "ws" role
  }

  async check(): Promise<HealthResult> {
    const isDraining = this.gateway.isDraining();

    if (isDraining) {
      return {
        status: "down",
        message: "WebSocket gateway is draining connections",
        details: {
          draining: true,
          subscribers: this.gateway.subscriberCount,
        },
      };
    }

    return {
      status: "up",
      message: "WebSocket gateway accepting connections",
      details: {
        draining: false,
        subscribers: this.gateway.subscriberCount,
      },
    };
  }
}
