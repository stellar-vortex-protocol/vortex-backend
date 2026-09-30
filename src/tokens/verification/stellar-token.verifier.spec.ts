import { xdr } from "@stellar/stellar-sdk";
import { StellarSacReader, StellarTokenVerifier, StellarVerificationError } from "./stellar-token.verifier";
import { retvalFromSimulation } from "./sdk-sac.simulator";
import { SimulatedSacReader, scValToString, scValToUint } from "./simulated-sac.reader";

const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const CLASSIC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function sac(meta: { symbol: string; decimals: number; name: string | null } | null): StellarSacReader {
  return { read: jest.fn().mockResolvedValue(meta) };
}

describe("StellarTokenVerifier", () => {
  it("treats CODE:ISSUER as a classic asset with 7 decimals", async () => {
    const verified = await new StellarTokenVerifier(sac(null)).verify(CLASSIC);
    expect(verified).toMatchObject({ exists: true, assetKind: "stellar-classic", symbol: "USDC", decimals: 7 });
  });

  it("treats native XLM as a classic asset", async () => {
    const verified = await new StellarTokenVerifier(sac(null)).verify("native");
    expect(verified).toMatchObject({ assetKind: "stellar-classic", symbol: "XLM", decimals: 7 });
  });

  it("reads SAC metadata from the contract reader", async () => {
    const verified = await new StellarTokenVerifier(
      sac({ symbol: "USDC", decimals: 7, name: "USD Coin" }),
    ).verify(SAC);
    expect(verified).toMatchObject({ exists: true, assetKind: "stellar-sac", symbol: "USDC", decimals: 7 });
  });

  it("reports a missing SAC contract", async () => {
    const verified = await new StellarTokenVerifier(sac(null)).verify(SAC);
    expect(verified.exists).toBe(false);
  });

  it("rejects an address that is neither classic nor a contract", async () => {
    await expect(new StellarTokenVerifier(sac(null)).verify("nope")).rejects.toBeInstanceOf(StellarVerificationError);
  });
});

describe("SimulatedSacReader fixtures", () => {
  it("decodes symbol and decimals ScVals and treats a null symbol as a missing contract", async () => {
    const symbol = xdr.ScVal.scvSymbol(Buffer.from("USDC"));
    const decimals = xdr.ScVal.scvU32(7);
    const name = xdr.ScVal.scvString(Buffer.from("USD Coin"));
    expect(scValToString(symbol)).toBe("USDC");
    expect(scValToUint(decimals)).toBe(7);
    expect(retvalFromSimulation({ results: [{ retval: symbol }] })).toBe(symbol);

    const reader = new SimulatedSacReader({
      simulate: jest.fn(async (_id: string, method: string) => {
        if (method === "symbol") return symbol;
        if (method === "decimals") return decimals;
        if (method === "name") return name;
        return null;
      }),
    });
    await expect(reader.read(SAC)).resolves.toEqual({ symbol: "USDC", decimals: 7, name: "USD Coin" });

    const missing = new SimulatedSacReader({ simulate: async () => null });
    await expect(missing.read(SAC)).resolves.toBeNull();
  });
});
