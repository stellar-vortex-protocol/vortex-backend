import { BadRequestException } from "@nestjs/common";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { AdminTokensService, TokenListPublisher } from "./admin-tokens.service";
import { InMemoryTokensRepository } from "./in-memory-tokens.repository";
import { TokensService } from "./tokens.service";
import { TokenVerifierService } from "./verification/token-verifier.service";
import { EvmTokenVerifier } from "./verification/evm-token.verifier";
import { StellarTokenVerifier } from "./verification/stellar-token.verifier";
import { ERC20_DECIMALS_SELECTOR, ERC20_NAME_SELECTOR, ERC20_SYMBOL_SELECTOR } from "./verification/evm-symbol";

const ADMIN: AdminPrincipal = { id: "ops", role: "admin" };
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const FRESH = "0x1111111111111111111111111111111111111111";

function bytes32(text: string): string {
  const word = Buffer.alloc(32);
  Buffer.from(text).copy(word);
  return `0x${word.toString("hex")}`;
}

function uint(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function harness(meta: { symbol: string; decimals: number; name: string; code?: string }) {
  const repo = new InMemoryTokensRepository();
  const publisher = new TokenListPublisher();
  const published: unknown[] = [];
  publisher.publish = async (event) => {
    published.push(event);
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const evm = new EvmTokenVerifier({
    getCode: async () => meta.code ?? "0x6080",
    call: async (_chain, _address, data) => {
      if (data === ERC20_DECIMALS_SELECTOR) return uint(meta.decimals);
      if (data === ERC20_SYMBOL_SELECTOR) return bytes32(meta.symbol);
      if (data === ERC20_NAME_SELECTOR) return bytes32(meta.name);
      throw new Error(data);
    },
  });
  const stellar = new StellarTokenVerifier({
    read: async () => ({ symbol: "USDC", decimals: 7, name: "USD Coin" }),
  });
  const service = new AdminTokensService(
    repo,
    new TokenVerifierService(evm, stellar),
    audit as unknown as AdminAuditService,
    publisher,
  );
  return { repo, service, audit, published, tokens: new TokensService(repo) };
}

describe("AdminTokensService", () => {
  it("persists on-chain metadata, audits the write, bumps the cache and emits token_list_updated", async () => {
    const { service, audit, published, repo, tokens } = harness({ symbol: "DAI", decimals: 18, name: "Dai" });
    const before = repo.cacheGeneration();
    const saved = await service.create({ chain: "ethereum", address: FRESH }, ADMIN);
    expect(saved).toMatchObject({ symbol: "DAI", decimals: 18, status: "active", assetKind: "evm" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "token.create", actor: "ops" }));
    expect(repo.cacheGeneration()).toBe(before + 1);
    expect(published).toEqual([
      expect.objectContaining({ type: "token_list_updated", action: "created", address: FRESH, status: "active" }),
    ]);
    const listed = await tokens.getByChain("ethereum");
    expect(Array.isArray(listed.tokens) && listed.tokens.some((token) => token.address === FRESH)).toBe(true);
  });

  it("rejects a decimals mismatch and does not persist or emit", async () => {
    const { service, repo, published, audit } = harness({ symbol: "DAI", decimals: 18, name: "Dai" });
    const before = repo.cacheGeneration();
    await expect(
      service.create({ chain: "ethereum", address: FRESH, decimals: 6, symbol: "DAI" }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findByAddressAndChain(FRESH, "ethereum")).toBeUndefined();
    expect(repo.cacheGeneration()).toBe(before);
    expect(published).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("rejects a symbol mismatch with both sides in the error body", async () => {
    const { service } = harness({ symbol: "DAI", decimals: 18, name: "Dai" });
    try {
      await service.create({ chain: "ethereum", address: FRESH, symbol: "USDC" }, ADMIN);
      throw new Error("expected mismatch");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { code: string; mismatches: unknown[] };
      expect(body.code).toBe("METADATA_MISMATCH");
      expect(body.mismatches).toEqual([expect.objectContaining({ field: "symbol", supplied: "USDC", onChain: "DAI" })]);
    }
  });

  it("does not persist when the contract is missing", async () => {
    const { service, repo } = harness({ symbol: "DAI", decimals: 18, name: "Dai", code: "0x" });
    await expect(service.create({ chain: "ethereum", address: FRESH }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findByAddressAndChain(FRESH, "ethereum")).toBeUndefined();
  });

  it("moves active → paused → delisted and hides only the delisted token", async () => {
    const { service, tokens } = harness({ symbol: "USDC", decimals: 6, name: "USD Coin" });
    await service.update({ chain: "ethereum", address: USDC, status: "paused" }, ADMIN);
    await expect(tokens.resolveSrcTokenOrThrow("ethereum", USDC)).rejects.toBeInstanceOf(BadRequestException);
    const pausedList = await tokens.getByChain("ethereum");
    expect(Array.isArray(pausedList.tokens) && pausedList.tokens.some((token) => token.address === USDC)).toBe(true);

    await service.delist({ chain: "ethereum", address: USDC }, ADMIN);
    const hidden = await tokens.getByChain("ethereum");
    expect(Array.isArray(hidden.tokens) && hidden.tokens.some((token) => token.address === USDC)).toBe(false);
    await expect(tokens.resolveSrcToken("ethereum", USDC)).resolves.toMatchObject({ symbol: "USDC", decimals: 6 });
  });

  it("leaves an already-created intent usable after the token is delisted", async () => {
    const { service, tokens } = harness({ symbol: "USDC", decimals: 6, name: "USD Coin" });
    const resolved = await tokens.resolveSrcTokenOrThrow("ethereum", USDC);
    const intent = { intentId: "intent-1", state: "open", srcToken: { ...resolved }, minDstAmount: "1" };
    await service.delist({ chain: "ethereum", address: USDC }, ADMIN);
    expect(intent.state).toBe("open");
    expect(intent.srcToken.symbol).toBe("USDC");
    await expect(tokens.resolveSrcToken("ethereum", USDC)).resolves.toMatchObject({ address: USDC });
    await expect(tokens.resolveSrcTokenOrThrow("ethereum", USDC)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("verifies a classic Stellar asset without a SAC reader hit", async () => {
    const { service } = harness({ symbol: "DAI", decimals: 18, name: "Dai" });
    const saved = await service.create(
      {
        chain: "stellar",
        address: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        symbol: "USDC",
        decimals: 7,
      },
      ADMIN,
    );
    expect(saved.assetKind).toBe("stellar-classic");
  });
});
