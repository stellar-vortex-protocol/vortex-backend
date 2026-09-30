import { EgressPurpose, HttpEgressService } from "../../common/http-egress";
import { EvmChainReader } from "./evm-token.verifier";

/**
 * JSON-RPC `eth_call` / `eth_getCode` reader. Tests inject a fake
 * {@link EvmChainReader}; this class is the production adapter.
 */
export class HttpEvmChainReader implements EvmChainReader {
  constructor(
    private readonly urls: Record<string, string>,
    private readonly egress: HttpEgressService,
  ) {}

  async getCode(chain: string, address: string): Promise<string> {
    return this.rpc(chain, "eth_getCode", [address, "latest"]);
  }

  async call(chain: string, address: string, data: string): Promise<string> {
    return this.rpc(chain, "eth_call", [{ to: address, data }, "latest"]);
  }

  private async rpc(chain: string, method: string, params: unknown[]): Promise<string> {
    const url = this.urls[chain.toLowerCase()];
    if (!url) {
      throw new Error(`No EVM RPC URL configured for chain '${chain}'`);
    }
    const response = await this.egress.fetch(url, {
      method: "POST",
      purpose: EgressPurpose.RPC,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const parsed = JSON.parse(response.body) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `${method} failed`);
    }
    if (typeof parsed.result !== "string") {
      throw new Error(`${method} returned no hex result`);
    }
    return parsed.result;
  }
}
