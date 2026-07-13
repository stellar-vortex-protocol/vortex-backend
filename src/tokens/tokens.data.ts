export interface SourceToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number;
}

export interface StellarToken {
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number;
}

// Static registry for now. In production this is sourced from a token list service
// (e.g. CoinGecko / chain-specific token lists) with live price feeds.
export const SUPPORTED_TOKENS: Record<string, SourceToken[]> = {
  ethereum: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1.0 },
    { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", name: "Wrapped Ether", decimals: 18, priceUSD: 3512.80 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8, priceUSD: 67420.50 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", decimals: 6, priceUSD: 1.0 },
  ],
  base: [
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1.0 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18, priceUSD: 3512.80 },
  ],
  polygon: [
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1.0 },
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", name: "Wrapped Ether", decimals: 18, priceUSD: 3512.80 },
    { address: "0x0000000000000000000000000000000000001010", symbol: "MATIC", name: "Polygon", decimals: 18, priceUSD: 0.58 },
  ],
  arbitrum: [
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1.0 },
    { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", name: "Wrapped Ether", decimals: 18, priceUSD: 3512.80 },
  ],
  optimism: [
    { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1.0 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18, priceUSD: 3512.80 },
  ],
  avalanche: [
    { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1.0 },
    { address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", symbol: "WETH.e", name: "Wrapped Ether", decimals: 18, priceUSD: 3512.80 },
  ],
};

export const STELLAR_TOKENS: StellarToken[] = [
  { contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", symbol: "USDC", name: "USD Coin", decimals: 7, priceUSD: 1.0 },
  { contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", symbol: "XLM", name: "Stellar Lumens", decimals: 7, priceUSD: 0.1182 },
  { contract: "CCZX67YLZHIILF5GHZ5MUUTK7KJKLYQEQS2K5VKBMQ22YOAKDPZ43JT", symbol: "yXLM", name: "Yield XLM", decimals: 7, priceUSD: 0.118 },
];
