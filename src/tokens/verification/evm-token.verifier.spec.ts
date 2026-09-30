import { EvmChainReader, EvmTokenVerifier, EvmVerificationError } from "./evm-token.verifier";
import { ERC20_DECIMALS_SELECTOR, ERC20_NAME_SELECTOR, ERC20_SYMBOL_SELECTOR } from "./evm-symbol";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function bytes32(text: string): string {
  const word = Buffer.alloc(32);
  Buffer.from(text).copy(word);
  return `0x${word.toString("hex")}`;
}

function uint(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function reader(overrides: Partial<Record<"code" | "decimals" | "symbol" | "name", string>> = {}): EvmChainReader {
  const code = overrides.code ?? "0x60806040";
  const decimals = overrides.decimals ?? uint(6);
  const symbol = overrides.symbol ?? bytes32("USDC");
  const name = overrides.name ?? bytes32("USD Coin");
  return {
    getCode: jest.fn().mockResolvedValue(code),
    call: jest.fn(async (_chain: string, _address: string, data: string) => {
      if (data === ERC20_DECIMALS_SELECTOR) return decimals;
      if (data === ERC20_SYMBOL_SELECTOR) return symbol;
      if (data === ERC20_NAME_SELECTOR) return name;
      throw new Error(`unexpected selector ${data}`);
    }),
  };
}

describe("EvmTokenVerifier", () => {
  it("accepts a contract with matching decimals and a bytes32 symbol", async () => {
    const verified = await new EvmTokenVerifier(reader()).verify("ethereum", USDC);
    expect(verified).toMatchObject({ exists: true, assetKind: "evm", decimals: 6, symbol: "USDC", name: "USD Coin" });
  });

  it("reports a missing contract without throwing", async () => {
    const verified = await new EvmTokenVerifier(reader({ code: "0x" })).verify("ethereum", USDC);
    expect(verified.exists).toBe(false);
  });

  it("rejects an undecodable symbol", async () => {
    const verifier = new EvmTokenVerifier(reader({ symbol: "0x" + "00".repeat(32) }));
    await expect(verifier.verify("ethereum", USDC)).rejects.toBeInstanceOf(EvmVerificationError);
  });

  it("rejects a non-address", async () => {
    await expect(new EvmTokenVerifier(reader()).verify("ethereum", "not-an-address")).rejects.toBeInstanceOf(
      EvmVerificationError,
    );
  });
});
