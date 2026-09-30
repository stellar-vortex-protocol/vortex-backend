import { BadRequestException } from "@nestjs/common";
import { InMemoryTokensRepository } from "./in-memory-tokens.repository";
import { TokensService } from "./tokens.service";
import { SUPPORTED_TOKENS, STELLAR_TOKENS } from "./tokens.data";

/**
 * TokensService is backed by ITokensRepository so the registry can move to
 * Postgres without touching callers. The in-memory adapter is injected here
 * and the async read methods are awaited, matching the production shape.
 */
describe("TokensService", () => {
  let service: TokensService;

  beforeEach(() => {
    service = new TokensService(new InMemoryTokensRepository());
  });

  it("getByChain with no chain returns the full registry plus Stellar tokens", async () => {
    const result = await service.getByChain();
    // Both token maps present
    expect(result).toHaveProperty("tokens");
    expect(result).toHaveProperty("stellarTokens");
    expect(result.tokens).toHaveProperty("ethereum");
  });

  it("getByChain('stellar') returns only Stellar tokens", async () => {
    const result = await service.getByChain("stellar");
    expect(result.chain).toBe("stellar");
    expect(Array.isArray(result.tokens)).toBe(true);
  });

  it("getByChain with a known chain returns that chain's tokens", async () => {
    const result = await service.getByChain("polygon");
    expect(result.chain).toBe("polygon");
    expect(Array.isArray(result.tokens)).toBe(true);
  });

  it("getByChain with an unknown chain falls back to the full registry", async () => {
    const result = await service.getByChain("not-a-real-chain");
    expect(result).toHaveProperty("tokens");
    expect(result.tokens).toHaveProperty("ethereum");
  });

  it("getStellarTokens returns the Stellar token list", async () => {
    const result = await service.getStellarTokens();
    expect(Array.isArray(result.tokens)).toBe(true);
    expect(result.tokens.length).toBeGreaterThan(0);
  });

  // ── resolveSrcToken ──────────────────────────────────────────────────────

  describe("resolveSrcToken", () => {
    it("resolves a known Ethereum token by address", async () => {
      const usdcAddr = SUPPORTED_TOKENS["ethereum"][0].address;
      const result = await service.resolveSrcToken("ethereum", usdcAddr);
      expect(result).toBeDefined();
      expect(result!.kind).toBe("src");
      expect(result!.symbol).toBe("USDC");
      expect(result!.chain).toBe("ethereum");
      expect(typeof result!.priceUSD).toBe("number");
    });

    it("resolves a known Base token", async () => {
      const addr = SUPPORTED_TOKENS["base"][0].address;
      const result = await service.resolveSrcToken("base", addr);
      expect(result).toBeDefined();
      expect(result!.chain).toBe("base");
    });

    it("resolves a known Polygon token", async () => {
      const addr = SUPPORTED_TOKENS["polygon"][0].address;
      const result = await service.resolveSrcToken("polygon", addr);
      expect(result).toBeDefined();
      expect(result!.chain).toBe("polygon");
    });

    it("resolves a known Arbitrum token", async () => {
      const addr = SUPPORTED_TOKENS["arbitrum"][0].address;
      const result = await service.resolveSrcToken("arbitrum", addr);
      expect(result).toBeDefined();
      expect(result!.chain).toBe("arbitrum");
    });

    it("resolves a Stellar source token by contract ID", async () => {
      const contract = STELLAR_TOKENS[0].contract;
      const result = await service.resolveSrcToken("stellar", contract);
      expect(result).toBeDefined();
      expect(result!.kind).toBe("src");
      expect(result!.chain).toBe("stellar");
      expect(result!.address).toBe(contract);
    });

    it("returns undefined for an unknown ethereum address", async () => {
      expect(await service.resolveSrcToken("ethereum", "0xdeadbeef")).toBeUndefined();
    });

    it("returns undefined for an unknown stellar contract", async () => {
      expect(await service.resolveSrcToken("stellar", "CUNKNOWN")).toBeUndefined();
    });

    it("returns undefined for an unknown chain", async () => {
      // "optimism" is in the SUPPORTED_TOKENS registry but let's verify a truly unknown chain
      expect(await service.resolveSrcToken("avalanche" as never, "0xunknown")).toBeUndefined();
    });
  });

  // ── resolveDstToken ──────────────────────────────────────────────────────

  describe("resolveDstToken", () => {
    it("resolves a known Stellar USDC contract", async () => {
      const contract = STELLAR_TOKENS[0].contract; // USDC
      const result = await service.resolveDstToken(contract);
      expect(result).toBeDefined();
      expect(result!.kind).toBe("dst");
      expect(result!.symbol).toBe("USDC");
      expect(result!.contract).toBe(contract);
      expect(typeof result!.priceUSD).toBe("number");
    });

    it("resolves XLM contract", async () => {
      const xlm = STELLAR_TOKENS.find((t) => t.symbol === "XLM")!;
      const result = await service.resolveDstToken(xlm.contract);
      expect(result).toBeDefined();
      expect(result!.symbol).toBe("XLM");
    });

    it("returns undefined for an unknown contract", async () => {
      expect(await service.resolveDstToken("CNOTEXIST")).toBeUndefined();
    });

    it("returns undefined for an empty string", async () => {
      expect(await service.resolveDstToken("")).toBeUndefined();
    });
  });

  // ── #276: OrThrow variants reject unrecognised tokens ─────────────────────

  describe("resolveSrcTokenOrThrow", () => {
    it("returns the resolved token for a known chain + address", async () => {
      const usdcAddr = SUPPORTED_TOKENS["ethereum"][0].address;
      const result = await service.resolveSrcTokenOrThrow("ethereum", usdcAddr);
      expect(result.symbol).toBe("USDC");
      expect(result.priceUSD).toBe(1.0);
    });

    it("throws BadRequestException for an unknown address on a known chain", async () => {
      await expect(
        service.resolveSrcTokenOrThrow(
          "ethereum",
          "0x1111111111111111111111111111111111111111",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws BadRequestException for an unknown Stellar source contract", async () => {
      await expect(service.resolveSrcTokenOrThrow("stellar", "CUNKNOWN")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("resolveDstTokenOrThrow", () => {
    it("returns the resolved token for a known Stellar contract", async () => {
      const contract = STELLAR_TOKENS[0].contract;
      const result = await service.resolveDstTokenOrThrow(contract);
      expect(result.contract).toBe(contract);
    });

    it("throws BadRequestException for an unknown contract", async () => {
      await expect(service.resolveDstTokenOrThrow("CNOTEXIST")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("throws BadRequestException for an empty contract", async () => {
      await expect(service.resolveDstTokenOrThrow("")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
