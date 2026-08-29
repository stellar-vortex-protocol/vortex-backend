/**
 * Regression guard for issue #128.
 *
 * Ensures that:
 *  1. CreateIntentDto's @IsIn validator uses the same canonical list as
 *     `SupportedChain` (guaranteed structurally after the refactor — this
 *     test documents the contract).
 *  2. Every EVM chain declared in SUPPORTED_CHAINS has a corresponding entry
 *     in tokens.data.ts so the token registry never silently lags behind.
 */
import { SUPPORTED_CHAINS } from "./intents.types";
import { SUPPORTED_TOKENS } from "../tokens/tokens.data";

describe("SUPPORTED_CHAINS sync guard (#128)", () => {
  it("SUPPORTED_CHAINS contains at least 'stellar' and at least one EVM chain", () => {
    expect(SUPPORTED_CHAINS).toContain("stellar");
    const evmChains = SUPPORTED_CHAINS.filter((c) => c !== "stellar");
    expect(evmChains.length).toBeGreaterThan(0);
  });

  it("every EVM chain in SUPPORTED_CHAINS has token entries in tokens.data.ts", () => {
    const evmChains = SUPPORTED_CHAINS.filter((c) => c !== "stellar");
    const missingChains: string[] = [];

    for (const chain of evmChains) {
      const tokens = SUPPORTED_TOKENS[chain];
      if (!tokens || tokens.length === 0) {
        missingChains.push(chain);
      }
    }

    expect(missingChains).toEqual([]);
  });

  it("tokens.data.ts has no extra EVM chains that are not listed in SUPPORTED_CHAINS", () => {
    const tokenChains = Object.keys(SUPPORTED_TOKENS);
    const unrecognised = tokenChains.filter(
      (c) => !(SUPPORTED_CHAINS as readonly string[]).includes(c),
    );
    expect(unrecognised).toEqual([]);
  });
});
