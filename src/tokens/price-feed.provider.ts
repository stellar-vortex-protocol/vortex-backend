export interface PriceFeedProvider {
  /**
   * Return a positive USD quote for a token symbol. Consumers making
   * collateral decisions must independently enforce their quote-freshness
   * policy and fail closed when no usable quote is available.
   */
  getUsdPrice(symbol: string): Promise<number>;
}
