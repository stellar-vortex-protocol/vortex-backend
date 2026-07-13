import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";

const SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class IntentsSweeperService implements OnModuleInit, OnModuleDestroy {
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  private sweep() {
    const now = Math.floor(Date.now() / 1000);
    let expiredCount = 0;

    for (const intent of this.intentsService.getByState("open")) {
      if (intent.deadline <= now) {
        this.intentsService.update(intent.intentId, { state: "expired" });
        expiredCount++;
        this.intentsGateway.broadcast({ type: "intent_expired", intentId: intent.intentId });
      }
    }

    if (expiredCount > 0) {
      console.log(`[sweeper] Expired ${expiredCount} intent(s)`);
    }
  }
}
