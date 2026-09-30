import { HttpEgressService } from "../../common/http-egress";
import { HttpEvmChainReader } from "./http-evm-chain.reader";

describe("HttpEvmChainReader", () => {
  it("posts eth_call and eth_getCode fixtures and surfaces RPC errors", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6080" }) })
      .mockResolvedValueOnce({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "6".padStart(64, "0") }) });
    const egress = { fetch } as unknown as HttpEgressService;
    const reader = new HttpEvmChainReader({ ethereum: "https://rpc.example" }, egress);

    await expect(reader.getCode("ethereum", "0xabc")).resolves.toBe("0x6080");
    await expect(reader.call("ethereum", "0xabc", "0x313ce567")).resolves.toMatch(/^0x0+6$/);
    expect(fetch).toHaveBeenCalledWith(
      "https://rpc.example",
      expect.objectContaining({ method: "POST" }),
    );

    const failing = new HttpEvmChainReader({ ethereum: "https://rpc.example" }, {
      fetch: jest.fn().mockResolvedValue({ body: JSON.stringify({ error: { message: "execution reverted" } }) }),
    } as unknown as HttpEgressService);
    await expect(failing.call("ethereum", "0xabc", "0x313ce567")).rejects.toThrow(/execution reverted/);

    const unconfigured = new HttpEvmChainReader({}, egress);
    await expect(unconfigured.getCode("base", "0xabc")).rejects.toThrow(/No EVM RPC URL/);
  });
});
