import { Intent } from "./intents.types";

export function buildSeedIntents(now: number): Array<Omit<Intent, "intentId" | "createdAt">> {
  return [
    {
      user: "GABC...1234",
      srcChain: "ethereum",
      srcToken: {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "ethereum",
        priceUSD: 1.0,
      },
      srcAmount: "500000000", // 500 USDC
      dstToken: {
        contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        symbol: "USDC",
        decimals: 7,
      },
      minDstAmount: "4950000000", // 495 USDC (1% slippage)
      state: "open",
      deadline: now + 1200,
    },
    {
      user: "GDEF...5678",
      srcChain: "base",
      srcToken: {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        chain: "base",
        priceUSD: 3512.8,
      },
      srcAmount: "140000000000000000", // 0.14 ETH
      dstToken: {
        contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        symbol: "USDC",
        decimals: 7,
      },
      minDstAmount: "4800000000", // $480 USDC (accepting ~2% slippage)
      state: "open",
      deadline: now + 900,
    },
    {
      user: "GHIJ...9012",
      srcChain: "polygon",
      srcToken: {
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "polygon",
        priceUSD: 1.0,
      },
      srcAmount: "100000000", // 100 USDC
      dstToken: {
        contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        symbol: "XLM",
        decimals: 7,
      },
      minDstAmount: "8200000000", // ~820 XLM
      state: "accepted",
      solver: "SOLVER_ALPHA",
      deadline: now + 240,
    },
    {
      user: "GKLM...3456",
      srcChain: "arbitrum",
      srcToken: {
        address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        chain: "arbitrum",
        priceUSD: 3512.8,
      },
      srcAmount: "1000000000000000000", // 1 ETH
      dstToken: {
        contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        symbol: "USDC",
        decimals: 7,
      },
      minDstAmount: "34500000000", // 3450 USDC
      state: "filled",
      solver: "SOLVER_BETA",
      deadline: now - 300,
      filledAt: now - 120,
      fillAmount: "35100000000",
      txHash: "abc123def456",
    },
    {
      user: "GNOP...7890",
      srcChain: "optimism",
      srcToken: {
        address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "optimism",
        priceUSD: 1.0,
      },
      srcAmount: "200000000", // 200 USDC
      dstToken: {
        contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        symbol: "USDC",
        decimals: 7,
      },
      minDstAmount: "1980000000",
      state: "open",
      deadline: now + 1600,
    },
  ];
}
