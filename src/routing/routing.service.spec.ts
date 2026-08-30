import { RoutingService, RouteOptions } from "./routing.service";
import { TokenInfo } from "../intents/intents.types";

function usdcEthereum(): TokenInfo {
  return {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    chain: "ethereum",
    priceUSD: 1.0,
  };
}

function usdcStellar(): TokenInfo {
  return {
    address: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 7,
    chain: "stellar",
    priceUSD: 1.0,
  };
}

function wethEthereum(): TokenInfo {
  return {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    chain: "ethereum",
    priceUSD: 3512.8,
  };
}

function xlmStellar(): TokenInfo {
  return {
    address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    symbol: "XLM",
    name: "Stellar Lumens",
    decimals: 7,
    chain: "stellar",
    priceUSD: 0.12,
  };
}

const defaultOpts: RouteOptions = {
  totalFeesUSD: 0.05,
  priceImpact: 0.001,
  estimatedFillTime: 60,
};

describe("RoutingService", () => {
  let service: RoutingService;

  beforeEach(() => {
    service = new RoutingService();
  });

  // ── createDirectRoute ──────────────────────────────────────────────────────

  describe("createDirectRoute", () => {
    it("returns a route with a single 'transfer' step", () => {
      const route = service.createDirectRoute(usdcEthereum(), usdcStellar(), "SOLVER_A");
      expect(route.steps).toHaveLength(1);
      expect(route.steps[0].type).toBe("transfer");
      expect(route.steps[0].protocol).toBe("direct-solver");
    });

    it("sets fromChain and toChain correctly", () => {
      const route = service.createDirectRoute(usdcEthereum(), usdcStellar(), "SOLVER_A");
      expect(route.steps[0].fromChain).toBe("ethereum");
      expect(route.steps[0].toChain).toBe("stellar");
    });

    it("totalTime equals the single step's estimatedTime", () => {
      const route = service.createDirectRoute(usdcEthereum(), usdcStellar(), "SOLVER_A", defaultOpts);
      expect(route.totalTime).toBe(route.steps[0].estimatedTime);
    });

    it("uses opts.totalFeesUSD and opts.priceImpact when provided", () => {
      const route = service.createDirectRoute(usdcEthereum(), usdcStellar(), "SOLVER_A", defaultOpts);
      expect(route.totalFeesUSD).toBe(defaultOpts.totalFeesUSD);
      expect(route.priceImpact).toBe(defaultOpts.priceImpact);
    });

    it("defaults fees and priceImpact to 0 when opts are omitted", () => {
      const route = service.createDirectRoute(usdcEthereum(), usdcStellar(), "SOLVER_A");
      expect(route.totalFeesUSD).toBe(0);
      expect(route.priceImpact).toBe(0);
    });

    it("works from base chain", () => {
      const baseUsdc: TokenInfo = {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "base",
      };
      const route = service.createDirectRoute(baseUsdc, usdcStellar(), "SOLVER_B");
      expect(route.steps[0].fromChain).toBe("base");
    });
  });

  // ── createTwoHopRoute ──────────────────────────────────────────────────────

  describe("createTwoHopRoute", () => {
    it("returns a route with exactly 2 steps", () => {
      const route = service.createTwoHopRoute(wethEthereum(), xlmStellar(), "SOLVER_A");
      expect(route.steps).toHaveLength(2);
    });

    it("step 1 is a 'swap' on the source chain (srcToken → USDC)", () => {
      const route = service.createTwoHopRoute(wethEthereum(), xlmStellar(), "SOLVER_A");
      const step1 = route.steps[0];
      expect(step1.type).toBe("swap");
      expect(step1.fromToken.symbol).toBe("WETH");
      expect(step1.toToken.symbol).toBe("USDC");
      expect(step1.fromChain).toBe("ethereum");
      expect(step1.toChain).toBe("ethereum");
    });

    it("step 2 is a 'bridge' from source chain to Stellar (USDC → dstToken)", () => {
      const route = service.createTwoHopRoute(wethEthereum(), xlmStellar(), "SOLVER_A");
      const step2 = route.steps[1];
      expect(step2.type).toBe("bridge");
      expect(step2.fromToken.symbol).toBe("USDC");
      expect(step2.toToken.symbol).toBe("XLM");
      expect(step2.toChain).toBe("stellar");
    });

    it("totalTime is the sum of both steps", () => {
      const route = service.createTwoHopRoute(wethEthereum(), xlmStellar(), "SOLVER_A");
      const sum = route.steps.reduce((acc, s) => acc + s.estimatedTime, 0);
      expect(route.totalTime).toBe(sum);
    });

    it("uses the correct USDC address for each EVM chain", () => {
      const polygonWeth: TokenInfo = {
        address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        chain: "polygon",
      };
      const route = service.createTwoHopRoute(polygonWeth, xlmStellar(), "SOLVER_A");
      const step1 = route.steps[0];
      // Polygon USDC address
      expect(step1.toToken.address).toBe("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
    });

    it("passes opts.totalFeesUSD and opts.priceImpact through to the route", () => {
      const route = service.createTwoHopRoute(wethEthereum(), xlmStellar(), "SOLVER_A", defaultOpts);
      expect(route.totalFeesUSD).toBe(defaultOpts.totalFeesUSD);
      expect(route.priceImpact).toBe(defaultOpts.priceImpact);
    });
  });

  // ── buildRoute ─────────────────────────────────────────────────────────────

  describe("buildRoute", () => {
    it("chooses a direct route when src and dst have the same symbol (USDC → USDC)", () => {
      const route = service.buildRoute(usdcEthereum(), usdcStellar(), "SOLVER_A", defaultOpts);
      expect(route.steps).toHaveLength(1);
      expect(route.steps[0].type).toBe("transfer");
    });

    it("chooses a two-hop route when src is WETH and dst is XLM", () => {
      const route = service.buildRoute(wethEthereum(), xlmStellar(), "SOLVER_A", defaultOpts);
      expect(route.steps).toHaveLength(2);
    });

    it("two-hop route step 1 protocol is uniswap-v3", () => {
      const route = service.buildRoute(wethEthereum(), xlmStellar(), "SOLVER_A", defaultOpts);
      expect(route.steps[0].protocol).toBe("uniswap-v3");
    });

    it("two-hop route step 2 protocol is direct-solver", () => {
      const route = service.buildRoute(wethEthereum(), xlmStellar(), "SOLVER_A", defaultOpts);
      expect(route.steps[1].protocol).toBe("direct-solver");
    });

    it("direct route from polygon USDC to stellar USDC", () => {
      const polygonUsdc: TokenInfo = {
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "polygon",
      };
      const route = service.buildRoute(polygonUsdc, usdcStellar(), "SOLVER_C", defaultOpts);
      expect(route.steps).toHaveLength(1);
      expect(route.steps[0].fromChain).toBe("polygon");
    });

    it("route contains well-formed fromToken and toToken on each step", () => {
      const route = service.buildRoute(wethEthereum(), xlmStellar(), "SOLVER_A", defaultOpts);
      for (const step of route.steps) {
        expect(step.fromToken).toBeDefined();
        expect(step.toToken).toBeDefined();
        expect(typeof step.fromToken.symbol).toBe("string");
        expect(typeof step.toToken.symbol).toBe("string");
      }
    });
  });
});
