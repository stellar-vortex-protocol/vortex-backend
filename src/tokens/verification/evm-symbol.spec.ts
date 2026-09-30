import { decodeErc20String, decodeErc20Uint } from "./evm-symbol";

describe("ERC-20 metadata decoding", () => {
  it("decodes a bytes32 symbol", () => {
    const word = Buffer.alloc(32);
    Buffer.from("USDC").copy(word);
    expect(decodeErc20String(`0x${word.toString("hex")}`)).toBe("USDC");
  });

  it("decodes an ABI dynamic string", () => {
    const data = Buffer.from("USD Coin");
    const hex = [
      "0".repeat(62) + "20",
      data.length.toString(16).padStart(64, "0"),
      data.toString("hex").padEnd(64, "0"),
    ].join("");
    expect(decodeErc20String(`0x${hex}`)).toBe("USD Coin");
  });

  it("decodes decimals and rejects values above uint8", () => {
    expect(decodeErc20Uint("0x" + "6".padStart(64, "0"))).toBe(6);
    expect(decodeErc20Uint("0x" + "100".padStart(64, "0"))).toBeNull();
  });

  it("rejects empty and non-hex payloads", () => {
    expect(decodeErc20String("0x")).toBeNull();
    expect(decodeErc20String("0xzz")).toBeNull();
    expect(decodeErc20Uint("0x")).toBeNull();
  });
});
