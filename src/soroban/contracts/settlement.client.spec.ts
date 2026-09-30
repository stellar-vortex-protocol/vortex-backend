import { ConfigService } from "@nestjs/config";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { SettlementContractClient, SETTLEMENT_CODECS } from "./settlement.client";
import { ContractVersionService, ContractVersionUnsupportedException } from "../contract-version.service";
import { StellarTxService } from "../stellar-tx.service";
import { AppConfig } from "../../config/configuration";
import { Intent } from "../../intents/intents.types";

const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const intent: Intent = {
  intentId: "intent-1",
  user: Keypair.random().publicKey(),
  srcChain: "base",
  srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "base" },
  srcAmount: "1000000",
  dstToken: { contract: CONTRACT_ID, symbol: "USDC", decimals: 7 },
  minDstAmount: "990000",
  state: "open",
  createdAt: 1,
  deadline: 1234,
  version: 0,
  srcVerified: true,
};

function build(versions: Partial<ContractVersionService>) {
  const invokeContract = jest.fn().mockResolvedValue({ hash: "h", status: "SUCCESS", dryRun: false });
  const client = new SettlementContractClient(
    { invokeContract } as unknown as StellarTxService,
    versions as ContractVersionService,
    { get: () => CONTRACT_ID } as unknown as ConfigService<AppConfig, true>,
  );
  return { client, invokeContract };
}

describe("SettlementContractClient (issue #402)", () => {
  it("encodes create_intent with the codec for the deployed ABI", async () => {
    const { client, invokeContract } = build({
      assertWritable: jest.fn().mockResolvedValue({ abiVersion: "settlement-v1", wasmHash: "a" }),
    });

    await client.createIntent(intent);

    const call = invokeContract.mock.calls[0][0];
    expect(call).toMatchObject({ contractId: CONTRACT_ID, method: "create_intent" });
    expect(call.args.map(scValToNative)).toEqual([
      "intent-1",
      intent.user,
      "base",
      "0xabc",
      1000000n,
      CONTRACT_ID,
      990000n,
      1234n,
    ]);
  });

  it("never invokes the contract when its version is unsupported", async () => {
    const blocked = new ContractVersionUnsupportedException({
      contract: "settlement",
      contractId: CONTRACT_ID,
      status: "unknown_hash",
    });
    const { client, invokeContract } = build({ assertWritable: jest.fn().mockRejectedValue(blocked) });

    await expect(client.createIntent(intent)).rejects.toBe(blocked);
    expect(invokeContract).not.toHaveBeenCalled();
  });

  it("has a codec for every settlement ABI version", () => {
    expect(Object.keys(SETTLEMENT_CODECS)).toEqual(["settlement-v1"]);
  });
});
