import { TokensService } from "../tokens/tokens.service";
import { InMemoryTokensRepository } from "../tokens/in-memory-tokens.repository";
import { USD_PRICE_SCALE } from "./min-dst-amount.validation";
import { AggregatorService } from "./aggregator.service";

describe("AggregatorService", () => {
  it("returns scaled USD prices for a known USDC pair", async () => {
    const aggregator = new AggregatorService(new TokensService(new InMemoryTokensRepository()));
    const snapshot = await aggregator.getPriceSnapshot({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      nowMs: 42,
    });
    expect(snapshot.srcPriceUsd).toBe(USD_PRICE_SCALE);
    expect(snapshot.dstPriceUsd).toBe(USD_PRICE_SCALE);
    expect(snapshot.asOfMs).toBe(42);
  });

  it("returns null prices for an unknown destination contract", async () => {
    const aggregator = new AggregatorService(new TokensService(new InMemoryTokensRepository()));
    const snapshot = await aggregator.getPriceSnapshot({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "C" + "A".repeat(55),
    });
    expect(snapshot.dstPriceUsd).toBeNull();
    expect(snapshot.srcPriceUsd).toBe(USD_PRICE_SCALE);
  });
});
