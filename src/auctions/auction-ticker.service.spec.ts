import { Intent } from "../intents/intents.types";
import { IntentsGateway } from "../intents/intents.gateway";
import { IntentsService } from "../intents/intents.service";
import { AuctionTickerService } from "./auction-ticker.service";

const auctionIntent = {
  intentId: "auction-intent",
  user: "GUSER",
  srcChain: "ethereum",
  srcToken: { address: "0x1", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
  srcAmount: "1000",
  dstToken: { contract: "CDEST", symbol: "USDC", decimals: 7 },
  minDstAmount: "400",
  auction: { startDstAmount: "1000", decayStart: 1, decayEnd: 2 },
  state: "open",
  createdAt: 1,
  deadline: 10,
} as Intent;

describe("AuctionTickerService", () => {
  it("publishes changed prices, retries failed broadcasts, and prunes inactive intents", async () => {
    const getByState = jest.fn().mockResolvedValue([auctionIntent]);
    const broadcast = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const ticker = new AuctionTickerService(
      { getByState } as unknown as IntentsService,
      { broadcast } as unknown as IntentsGateway,
    );

    await ticker.publishPriceTicks();
    await ticker.publishPriceTicks();
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0]).toMatchObject({
      type: "auction_price",
      intentId: auctionIntent.intentId,
      currentDstAmount: "400",
    });

    getByState.mockResolvedValueOnce([]);
    await ticker.publishPriceTicks();
    getByState.mockResolvedValueOnce([auctionIntent]);
    await ticker.publishPriceTicks();
    expect(broadcast).toHaveBeenCalledTimes(3);
  });
});