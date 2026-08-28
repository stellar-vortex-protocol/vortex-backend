export interface PriceFeedProvider {
  getUsdPrice(symbol: string): Promise<number>;
}
