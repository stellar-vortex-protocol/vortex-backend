import { dutchAuctionPrice } from "./dutch";

const auction = { startDstAmount: "1000", decayStart: 100, decayEnd: 200 };

describe("dutchAuctionPrice", () => {
  it("returns the start price before decay and the floor after decay", () => {
    expect(dutchAuctionPrice(auction, 99, "400")).toBe("1000");
    expect(dutchAuctionPrice(auction, 100, "400")).toBe("1000");
    expect(dutchAuctionPrice(auction, 200, "400")).toBe("400");
    expect(dutchAuctionPrice(auction, 201, "400")).toBe("400");
  });

  it("interpolates with integer arithmetic and never increases", () => {
    let previous = 1000n;
    for (let timestamp = 101; timestamp < 200; timestamp++) {
      const current = BigInt(dutchAuctionPrice(auction, timestamp, "400"));
      expect(current).toBeLessThanOrEqual(previous);
      expect(current).toBeGreaterThanOrEqual(400n);
      previous = current;
    }
  });

  it("preserves precision for amounts above Number.MAX_SAFE_INTEGER", () => {
    const large = { startDstAmount: "900719925474099312345", decayStart: 10, decayEnd: 20 };
    expect(dutchAuctionPrice(large, 15, "1")).toBe("450359962737049656173");
  });
});