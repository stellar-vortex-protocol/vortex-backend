import { TokensService } from "./tokens.service";
import { SUPPORTED_TOKENS, STELLAR_TOKENS } from "./tokens.data";

describe("TokensService", () => {
  let service: TokensService;

  beforeEach(() => {
    service = new TokensService();
  });

  it("getByChain with no chain returns the full registry plus Stellar tokens", () => {
    const result = service.getByChain();
    expect(result).toEqual({ tokens: SUPPORTED_TOKENS, stellarTokens: STELLAR_TOKENS });
  });

  it("getByChain('stellar') returns only Stellar tokens", () => {
    const result = service.getByChain("stellar");
    expect(result).toEqual({ tokens: STELLAR_TOKENS, chain: "stellar" });
  });

  it("getByChain with a known chain returns that chain's tokens", () => {
    const result = service.getByChain("polygon");
    expect(result).toEqual({ tokens: SUPPORTED_TOKENS.polygon, chain: "polygon" });
  });

  it("getByChain with an unknown chain falls back to the full registry", () => {
    const result = service.getByChain("not-a-real-chain");
    expect(result).toEqual({ tokens: SUPPORTED_TOKENS, stellarTokens: STELLAR_TOKENS });
  });

  it("getStellarTokens returns the Stellar token list", () => {
    expect(service.getStellarTokens()).toEqual({ tokens: STELLAR_TOKENS });
  });
});
