import {
  decodeErc20String,
  decodeErc20Uint,
  ERC20_DECIMALS_SELECTOR,
  ERC20_NAME_SELECTOR,
  ERC20_SYMBOL_SELECTOR,
} from "./evm-symbol";
import { TokenAssetKind } from "../tokens.repository";

/** Read-only EVM JSON-RPC surface used to verify ERC-20 metadata. */
export interface EvmChainReader {
  getCode(chain: string, address: string): Promise<string>;
  call(chain: string, address: string, data: string): Promise<string>;
}

export interface VerifiedTokenMetadata {
  assetKind: TokenAssetKind;
  decimals: number;
  symbol: string;
  name: string | null;
  exists: boolean;
}

export class EvmVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmVerificationError";
  }
}

/**
 * Confirms an address is a contract and reads `decimals()` / `symbol()` /
 * `name()` before any registry write. `symbol()` accepts ABI strings and
 * bytes32. A failed `name()` is non-fatal; decimals and symbol are not.
 */
export class EvmTokenVerifier {
  constructor(private readonly reader: EvmChainReader) {}

  async verify(chain: string, address: string): Promise<VerifiedTokenMetadata> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new EvmVerificationError(`'${address}' is not an EVM address`);
    }
    const code = await this.reader.getCode(chain, address);
    if (isEmptyCode(code)) {
      return { assetKind: "evm", decimals: 0, symbol: "", name: null, exists: false };
    }
    const decimalsHex = await this.reader.call(chain, address, ERC20_DECIMALS_SELECTOR);
    const symbolHex = await this.reader.call(chain, address, ERC20_SYMBOL_SELECTOR);
    const decimals = decodeErc20Uint(decimalsHex);
    const symbol = decodeErc20String(symbolHex);
    if (decimals === null || symbol === null) {
      throw new EvmVerificationError(`Could not decode ERC-20 metadata for ${address} on ${chain}`);
    }
    let name: string | null = null;
    try {
      name = decodeErc20String(await this.reader.call(chain, address, ERC20_NAME_SELECTOR));
    } catch {
      name = null;
    }
    return { assetKind: "evm", decimals, symbol, name, exists: true };
  }
}

function isEmptyCode(code: string): boolean {
  const body = code.trim().toLowerCase().replace(/^0x/, "");
  return body.length === 0 || /^0+$/.test(body);
}
