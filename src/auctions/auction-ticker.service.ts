import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { IntentsGateway } from "../intents/intents.gateway";
import { IntentsService } from "../intents/intents.service";
import { dutchAuctionPrice } from "./dutch";

const AUCTION_TICK_INTERVAL_MS = 5_000;

@Injectable()
export class AuctionTickerService {
  private readonly logger = new Logger(AuctionTickerService.name);
  private readonly lastPrices = new Map<string, string>();
  private publishing = false;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  @Interval(AUCTION_TICK_INTERVAL_MS)
  async publishPriceTicks(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const intents = await this.intentsService.getByState("open");
      const activeIds = new Set<string>();
      for (const intent of intents) {
        if (!intent.auction) continue;
        activeIds.add(intent.intentId);
        const currentDstAmount = dutchAuctionPrice(intent.auction, now, intent.minDstAmount);
        if (this.lastPrices.get(intent.intentId) === currentDstAmount) continue;
        await this.intentsGateway.broadcast({
          type: "auction_price",
          intentId: intent.intentId,
          currentDstAmount,
          timestamp: now,
        });
        this.lastPrices.set(intent.intentId, currentDstAmount);
      }
      for (const intentId of this.lastPrices.keys()) {
        if (!activeIds.has(intentId)) this.lastPrices.delete(intentId);
      }
    } catch (error) {
      this.logger.warn(`Could not publish Dutch auction price ticks: ${(error as Error).message}`);
    } finally {
      this.publishing = false;
    }
  }
}