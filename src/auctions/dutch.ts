export interface DutchAuction {
  startDstAmount: string;
  decayStart: number;
  decayEnd: number;
  exclusiveSolver?: string;
  exclusivityEnd?: number;
}

/** Return the deterministic integer price for a Dutch auction at `timestamp`. */
export function dutchAuctionPrice(auction: DutchAuction, timestamp: number, minDstAmount: string): string {
  const startAmount = BigInt(auction.startDstAmount);
  const minAmount = BigInt(minDstAmount);
  if (timestamp <= auction.decayStart) return startAmount.toString();
  if (timestamp >= auction.decayEnd) return minAmount.toString();

  const elapsed = BigInt(timestamp - auction.decayStart);
  const duration = BigInt(auction.decayEnd - auction.decayStart);
  const priceDrop = ((startAmount - minAmount) * elapsed) / duration;
  return (startAmount - priceDrop).toString();
}