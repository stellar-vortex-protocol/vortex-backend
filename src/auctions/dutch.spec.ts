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

  describe("curve options", () => {
    const curves = ["linear", "exponential", "stepped"] as const;

    it.each(curves)("%s curve returns exact boundary prices", (curve) => {
      const shaped = { ...auction, curve };
      expect(dutchAuctionPrice(shaped, 99, "400")).toBe("1000");
      expect(dutchAuctionPrice(shaped, 100, "400")).toBe("1000");
      expect(dutchAuctionPrice(shaped, 200, "400")).toBe("400");
      expect(dutchAuctionPrice(shaped, 201, "400")).toBe("400");
    });

    it.each(curves)("%s curve is monotonic non-increasing and bounded", (curve) => {
      const shaped = { ...auction, curve };
      let previous = 1000n;
      for (let timestamp = 101; timestamp < 200; timestamp++) {
        const current = BigInt(dutchAuctionPrice(shaped, timestamp, "400"));
        expect(current).toBeLessThanOrEqual(previous);
        expect(current).toBeGreaterThanOrEqual(400n);
        previous = current;
      }
    });

    it("defaults to the linear curve when curve is omitted", () => {
      for (let timestamp = 101; timestamp < 200; timestamp++) {
        expect(dutchAuctionPrice(auction, timestamp, "400")).toBe(
          dutchAuctionPrice({ ...auction, curve: "linear" }, timestamp, "400"),
        );
      }
    });

    it("exponential curve front-loads concessions versus linear", () => {
      const exponential = { ...auction, curve: "exponential" as const };
      const midpoint = 150;
      expect(BigInt(dutchAuctionPrice(exponential, midpoint, "400"))).toBeLessThan(
        BigInt(dutchAuctionPrice(auction, midpoint, "400")),
      );
    });

    it("stepped curve produces discrete plateaus", () => {
      const stepped = { ...auction, curve: "stepped" as const, steps: 4 };
      const prices = new Set<string>();
      for (let timestamp = 101; timestamp < 200; timestamp++) {
        prices.add(dutchAuctionPrice(stepped, timestamp, "400"));
      }
      expect(prices.size).toBeLessThanOrEqual(4);
    });
  });
});