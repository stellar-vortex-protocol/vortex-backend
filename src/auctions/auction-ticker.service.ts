import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { IntentsGateway } from "../intents/intents.gateway";
import { IntentsService } from "../intents/intents.service";
import { dutchAuctionPrice } from "./dutch";

const AUCTION_TICK_INTERVAL_MS = 5_000;
const DEFAULT_PRICE_HISTORY_CAP = 200;

export interface AuctionPriceTick {
  currentDstAmount: string;
  timestamp: number;
}

@Injectable()
export class AuctionTickerService {
  private readonly logger = new Logger(AuctionTickerService.name);
  private readonly lastPrices = new Map<string, string>();
  private readonly priceHistory = new Map<string, AuctionPriceTick[]>();
  private readonly historyCap: number;
  private publishing = false;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
  ) {
    const configured = Number(process.env.AUCTION_PRICE_HISTORY_CAP);
    this.historyCap =
      Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_PRICE_HISTORY_CAP;
  }

  getPriceHistory(intentId: string): AuctionPriceTick[] {
    return [...(this.priceHistory.get(intentId) ?? [])];
  }

  private appendPriceTick(intentId: string, tick: AuctionPriceTick): void {
    const history = this.priceHistory.get(intentId) ?? [];
    history.push(tick);
    if (history.length > this.historyCap) {
      history.splice(0, history.length - this.historyCap);
    }
    this.priceHistory.set(intentId, history);
  }

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
        this.appendPriceTick(intent.intentId, { currentDstAmount, timestamp: now });
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
