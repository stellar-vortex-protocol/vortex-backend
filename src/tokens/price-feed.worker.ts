import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { LeaderElectionService, Singleton } from "../common/leader-election";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { PrismaService } from "../prisma/prisma.service";
import { PRICE_FEED_PROVIDER, PriceFeedProvider } from "./price-feed.provider";

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD_PERCENT = 50;

@Singleton("price-feed")
@Injectable()
export class PriceFeedWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceFeedWorker.name);
  private interval?: NodeJS.Timeout;
  private refreshInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRICE_FEED_PROVIDER) private readonly provider: PriceFeedProvider,
    private readonly killSwitch: KillSwitchService,
    private readonly leaderElection: LeaderElectionService,
    private readonly config: ConfigService,
    /** Read cache (issue #414): token lists and quote inputs carry prices. */
    @Optional() private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    this.leaderElection.registerWorker("price-feed", (isLeader) => {
      if (isLeader) {
        if (this.interval) return;
        void this.refreshPrices().catch((error: unknown) => this.logFailure(error));
        this.interval = setInterval(() => {
          void this.refreshPrices().catch((error: unknown) => this.logFailure(error));
        }, this.refreshIntervalMs());
      } else {
        this.stopInterval();
      }
    });
  }

  onModuleDestroy(): void {
    this.stopInterval();
  }

  async refreshPrices(): Promise<{ updated: number; failed: number; circuitBroken: boolean }> {
    if (this.refreshInProgress) {
      return { updated: 0, failed: 0, circuitBroken: false };
    }
    this.refreshInProgress = true;
    try {
      return await this.runRefresh();
    } finally {
      this.refreshInProgress = false;
    }
  }

  private async runRefresh(): Promise<{ updated: number; failed: number; circuitBroken: boolean }> {
    const tokens = await this.prisma.token.findMany({
      select: { id: true, symbol: true, priceUsd: true },
    });
    const pricesBySymbol = new Map<string, number>();
    let updated = 0;
    let failed = 0;
    const extremeMoves: Array<{ symbol: string; previous: number; current: number; change: number }> = [];
    const recordedAt = new Date();
    const threshold = this.breakerThresholdPercent();

    for (const token of tokens) {
      try {
        let price = pricesBySymbol.get(token.symbol.toUpperCase());
        if (price === undefined) {
          price = await this.provider.getUsdPrice(token.symbol);
          if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Price provider returned an invalid price for ${token.symbol}`);
          }
          pricesBySymbol.set(token.symbol.toUpperCase(), price);
        }

        await this.prisma.$transaction([
          this.prisma.token.update({ where: { id: token.id }, data: { priceUsd: price } }),
          this.prisma.priceHistory.create({
            data: { tokenId: token.id, priceUsd: price, recordedAt },
          }),
        ]);
        updated++;

        if (token.priceUsd !== null && token.priceUsd > 0) {
          const change = (Math.abs(price - token.priceUsd) / token.priceUsd) * 100;
          if (change > threshold) {
            extremeMoves.push({
              symbol: token.symbol,
              previous: token.priceUsd,
              current: price,
              change,
            });
          }
        }
      } catch (error) {
        failed++;
        this.logger.warn(
          `Price refresh failed for ${token.symbol} (${token.id}): ${this.errorMessage(error)}`,
        );
      }
    }

    if (updated > 0) await this.cache?.invalidate("tokens");

    if (extremeMoves.length > 0) {
      const move = extremeMoves[0];
      const reason = extremeMoves
        .map(({ symbol, previous, current, change }) =>
          `${symbol} moved ${change.toFixed(2)}% from $${previous} to $${current}`,
        )
        .join("; ");
      await this.killSwitch.pause({
        scope: "global",
        reasonCode: "PRICE_FEED_EXTREME_MOVE",
        reason: `Price circuit breaker triggered: ${reason}`,
        activatedBy: "price-feed-worker",
      });
      this.logger.error(
        `Price circuit breaker triggered by ${move.symbol}: ${move.change.toFixed(2)}% move`,
      );
    }

    return { updated, failed, circuitBroken: extremeMoves.length > 0 };
  }

  private refreshIntervalMs(): number {
    return this.config.get<number>("PRICE_FEED_REFRESH_INTERVAL_MS", DEFAULT_REFRESH_INTERVAL_MS);
  }

  private breakerThresholdPercent(): number {
    return this.config.get<number>(
      "PRICE_FEED_CIRCUIT_BREAKER_THRESHOLD_PERCENT",
      DEFAULT_CIRCUIT_BREAKER_THRESHOLD_PERCENT,
    );
  }

  private stopInterval(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private logFailure(error: unknown): void {
    this.logger.error(`Price refresh cycle failed: ${this.errorMessage(error)}`);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}