import { Asset } from "@stellar/stellar-sdk";
import { FillVerifierService } from "./fill-verifier.service";
import { NETWORK_PASSPHRASES } from "../config/configuration";
import { Intent } from "../intents/intents.types";

describe("FillVerifierService", () => {
  const intent = {
    intentId: "intent-123",
    user: "GDESTINATION",
    dstToken: { contract: Asset.native().contractId(NETWORK_PASSPHRASES.testnet), decimals: 7 },
    minDstAmount: "12000000",
  } as Intent;
  const config = {
    get: (key: string) => key === "stellar.network" ? "testnet" : "https://horizon.test",
  } as never;
  const service = new FillVerifierService(config);
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it("uses the delivered amount for path payments before verifying the minimum", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        successful: true,
        memo_type: "text",
        memo: intent.intentId,
        _links: { operations: { href: "ignored" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ _embedded: { records: [{
        type: "path_payment_strict_send",
        to: intent.user,
        asset_type: "native",
        destination_amount: "1.3",
        amount: "2.0",
      }] } }), { status: 200 }));

    await expect(service.verify("a".repeat(64), intent)).resolves.toEqual({
      status: "verified",
      deliveredAmount: "13000000",
      operation: "path_payment_strict_send",
    });
  });

  it("keeps a transaction not yet indexed by Horizon retryable", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(service.verify("b".repeat(64), intent)).resolves.toEqual({
      status: "pending",
      reason: "not_indexed",
    });
  });

  it("rejects a successful transaction without the intent binding memo", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      successful: true,
      memo_type: "text",
      memo: "another-intent",
    }), { status: 200 }));
    await expect(service.verify("c".repeat(64), intent)).resolves.toEqual({
      status: "rejected",
      reason: "intent_memo_mismatch",
    });
  });
});
