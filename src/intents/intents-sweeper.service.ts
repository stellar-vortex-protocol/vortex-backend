import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { MetricsRegistry } from "../common/metrics";

const SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class IntentsSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentsSweeperService.name);
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

  sweep() {
    const startMs = Date.now();
    const now = Math.floor(startMs / 1000);
    let expiredCount = 0;

    for (const intent of this.intentsService.getByState("open")) {
      if (intent.deadline <= now) {
        this.intentsService.update(intent.intentId, { state: "expired" });
        expiredCount++;
        this.intentsGateway.broadcast({ type: "intent_expired", intentId: intent.intentId });
      }
    }

    const durationMs = Date.now() - startMs;

    // ── metrics ──────────────────────────────────────────────────────────────
    MetricsRegistry.sweeper.sweepDurationMs.observe(durationMs);
    if (expiredCount > 0) {
      MetricsRegistry.sweeper.expiredTotal.inc(expiredCount);
    }
    // ─────────────────────────────────────────────────────────────────────────

    this.logger.debug(
      `sweep complete: expired=${expiredCount} duration=${durationMs}ms ` +
        `totalExpired=${MetricsRegistry.sweeper.expiredTotal.get()}`,
    );

    if (expiredCount > 0) {
      this.logger.log(`[sweeper] Expired ${expiredCount} intent(s) in ${durationMs}ms`);
    }
  }
}
