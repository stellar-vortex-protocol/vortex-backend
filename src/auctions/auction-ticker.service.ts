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
  private readonly batchModeEnabled: boolean;
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
    this.batchModeEnabled = process.env.AUCTION_BATCH_MODE_ENABLED === "true";
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
      const batchGroups = new Map<string, typeof intents>();
      for (const intent of intents) {
        if (!intent.auction) continue;
        activeIds.add(intent.intentId);
        const currentDstAmount = dutchAuctionPrice(intent.auction, now, intent.minDstAmount);
        if (this.batchModeEnabled) {
          const key = `${intent.srcToken}:${intent.dstToken}`;
          const group = batchGroups.get(key) ?? [];
          group.push(intent);
          batchGroups.set(key, group);
        }
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
      if (this.batchModeEnabled) {
        for (const [key, group] of batchGroups) {
          const [srcToken, dstToken] = key.split(":");
          let clearingDstAmount: bigint | null = null;
          for (const intent of group) {
            const price = BigInt(
              dutchAuctionPrice(intent.auction!, now, intent.minDstAmount),
            );
            if (clearingDstAmount === null || price < clearingDstAmount) {
              clearingDstAmount = price;
            }
          }
          if (clearingDstAmount === null) continue;
          await this.intentsGateway.broadcast({
            type: "batch_auction_price",
            srcToken,
            dstToken,
            intentIds: group.map((intent) => intent.intentId),
            clearingDstAmount: clearingDstAmount.toString(),
            timestamp: now,
          });
        }
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
