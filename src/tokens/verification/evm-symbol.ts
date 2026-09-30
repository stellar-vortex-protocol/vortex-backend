/**
 * Decode an ERC-20 `symbol()` (or `name()`) eth_call result.
 *
 * Standard tokens return an ABI dynamic `string`. A common non-standard
 * implementation (MKR and older DSToken forks) returns a raw `bytes32`.
 * Both shapes are accepted. Empty or truncated payloads return null.
 */
export function decodeErc20String(hex: string): string | null {
  const body = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!body || /[^0-9a-f]/.test(body)) return null;

  if (body.length === 64) return decodeBytes32(body);

  if (body.length >= 192 && body.length % 64 === 0) {
    const length = Number(BigInt(`0x${body.slice(64, 128)}`));
    if (!Number.isFinite(length) || length < 0 || length > 256) return null;
    const data = body.slice(128, 128 + length * 2);
    if (data.length !== length * 2) return null;
    const text = Buffer.from(data, "hex").toString("utf8").replace(/\0+$/g, "").trim();
    return text.length > 0 ? text : null;
  }

  return null;
}

/** ABI-encoded uint256, the shape `decimals()` returns. */
export function decodeErc20Uint(hex: string): number | null {
  const body = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!body || /[^0-9a-f]/.test(body) || body.length < 64) return null;
  const value = BigInt(`0x${body.slice(0, 64)}`);
  if (value > BigInt(255)) return null;
  return Number(value);
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

function decodeBytes32(word: string): string | null {
  const text = Buffer.from(word, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  if (!text || hasControlChar(text)) return null;
  return text;
}

export const ERC20_DECIMALS_SELECTOR = "0x313ce567";
export const ERC20_SYMBOL_SELECTOR = "0x95d89b41";
export const ERC20_NAME_SELECTOR = "0x06fdde03";
