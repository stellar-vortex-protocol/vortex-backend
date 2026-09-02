import { BadRequestException } from "@nestjs/common";
import { TokensService } from "./tokens.service";
import { SUPPORTED_TOKENS, STELLAR_TOKENS } from "./tokens.data";

describe("TokensService", () => {
  let service: TokensService;

  beforeEach(() => {
    service = new TokensService();
  });

  it("getByChain with no chain returns the full registry plus Stellar tokens", () => {
    const result = service.getByChain();
    // Both token lists present
    expect(result).toHaveProperty("tokens");
    expect(result).toHaveProperty("stellarTokens");
  });

  it("getByChain('stellar') returns only Stellar tokens", () => {
    const result = service.getByChain("stellar");
    expect(result.chain).toBe("stellar");
    expect(Array.isArray(result.tokens)).toBe(true);
  });

  it("getByChain with a known chain returns that chain's tokens", () => {
    const result = service.getByChain("polygon");
    expect(result.chain).toBe("polygon");
    expect(Array.isArray(result.tokens)).toBe(true);
  });

  it("getByChain with an unknown chain falls back to the full registry", () => {
    const result = service.getByChain("not-a-real-chain");
    expect(result).toHaveProperty("tokens");
  });

  it("getStellarTokens returns the Stellar token list", () => {
    const result = service.getStellarTokens();
    expect(Array.isArray(result.tokens)).toBe(true);
    expect(result.tokens.length).toBeGreaterThan(0);
  });

  // ── resolveSrcToken ──────────────────────────────────────────────────────

  describe("resolveSrcToken", () => {
    it("resolves a known Ethereum token by address", () => {
      const usdcAddr = SUPPORTED_TOKENS["ethereum"][0].address;
      const result = service.resolveSrcToken("ethereum", usdcAddr);
      expect(result).toBeDefined();
      expect(result!.kind).toBe("src");
      expect(result!.symbol).toBe("USDC");
      expect(result!.chain).toBe("ethereum");
      expect(typeof result!.priceUSD).toBe("number");
    });

    it("resolves a known Base token", () => {
      const addr = SUPPORTED_TOKENS["base"][0].address;
      const result = service.resolveSrcToken("base", addr);
      expect(result).toBeDefined();
      expect(result!.chain).toBe("base");
    });

    it("resolves a known Polygon token", () => {
      const addr = SUPPORTED_TOKENS["polygon"][0].address;
      const result = service.resolveSrcToken("polygon", addr);
      expect(result).toBeDefined();
      expect(result!.chain).toBe("polygon");
    });

    it("resolves a known Arbitrum token", () => {
      const addr = SUPPORTED_TOKENS["arbitrum"][0].address;
      const result = service.resolveSrcToken("arbitrum", addr);
      expect(result).toBeDefined();
      expect(result!.chain).toBe("arbitrum");
    });

    it("resolves a Stellar source token by contract ID", () => {
      const contract = STELLAR_TOKENS[0].contract;
      const result = service.resolveSrcToken("stellar", contract);
      expect(result).toBeDefined();
      expect(result!.kind).toBe("src");
      expect(result!.chain).toBe("stellar");
      expect(result!.address).toBe(contract);
    });

    it("returns undefined for an unknown ethereum address", () => {
      expect(service.resolveSrcToken("ethereum", "0xdeadbeef")).toBeUndefined();
    });

    it("returns undefined for an unknown stellar contract", () => {
      expect(service.resolveSrcToken("stellar", "CUNKNOWN")).toBeUndefined();
    });

    it("returns undefined for an unknown chain", () => {
      // "optimism" is in the SUPPORTED_TOKENS registry but let's verify a truly unknown chain
      expect(service.resolveSrcToken("avalanche" as any, "0xunknown")).toBeUndefined();
    });
  });

  // ── resolveDstToken ──────────────────────────────────────────────────────

  describe("resolveDstToken", () => {
    it("resolves a known Stellar USDC contract", () => {
      const contract = STELLAR_TOKENS[0].contract; // USDC
      const result = service.resolveDstToken(contract);
      expect(result).toBeDefined();
      expect(result!.kind).toBe("dst");
      expect(result!.symbol).toBe("USDC");
      expect(result!.contract).toBe(contract);
      expect(typeof result!.priceUSD).toBe("number");
    });

    it("resolves XLM contract", () => {
      const xlm = STELLAR_TOKENS.find((t) => t.symbol === "XLM")!;
      const result = service.resolveDstToken(xlm.contract);
      expect(result).toBeDefined();
      expect(result!.symbol).toBe("XLM");
    });

    it("returns undefined for an unknown contract", () => {
      expect(service.resolveDstToken("CNOTEXIST")).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
      expect(service.resolveDstToken("")).toBeUndefined();
    });
  });

  // ── #276: OrThrow variants reject unrecognised tokens ─────────────────────

  describe("resolveSrcTokenOrThrow", () => {
    it("returns the resolved token for a known chain + address", () => {
      const usdcAddr = SUPPORTED_TOKENS["ethereum"][0].address;
      const result = service.resolveSrcTokenOrThrow("ethereum", usdcAddr);
      expect(result.symbol).toBe("USDC");
      expect(result.priceUSD).toBe(1.0);
    });

    it("throws BadRequestException for an unknown address on a known chain", () => {
      expect(() =>
        service.resolveSrcTokenOrThrow("ethereum", "0x1111111111111111111111111111111111111111"),
      ).toThrow(BadRequestException);
    });

    it("throws BadRequestException for an unknown Stellar source contract", () => {
      expect(() => service.resolveSrcTokenOrThrow("stellar", "CUNKNOWN")).toThrow(
        BadRequestException,
      );
    });
  });

  describe("resolveDstTokenOrThrow", () => {
    it("returns the resolved token for a known Stellar contract", () => {
      const contract = STELLAR_TOKENS[0].contract;
      const result = service.resolveDstTokenOrThrow(contract);
      expect(result.contract).toBe(contract);
    });

    it("throws BadRequestException for an unknown contract", () => {
      expect(() => service.resolveDstTokenOrThrow("CNOTEXIST")).toThrow(BadRequestException);
    });

    it("throws BadRequestException for an empty contract", () => {
      expect(() => service.resolveDstTokenOrThrow("")).toThrow(BadRequestException);
    });
  });
});
