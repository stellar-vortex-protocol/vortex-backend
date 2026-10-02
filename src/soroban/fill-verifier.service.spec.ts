import { Asset } from "@stellar/stellar-sdk";
import { FillVerifierService } from "./fill-verifier.service";
import { HttpEgressService } from "../common/http-egress";
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

  // Horizon traffic goes through HttpEgressService (the SSRF-guarded transport
  // enforced by lint), so the egress layer is spied and fed queued Response
  // fixtures instead of mocking global fetch.
  const queued: Response[] = [];
  const fetchSpy = jest.spyOn(HttpEgressService.prototype, "fetch");
  fetchSpy.mockImplementation(async () => {
    const next = queued.shift();
    if (!next) throw new Error("no queued Horizon response");
    return { statusCode: next.status, headers: {}, body: await next.text(), bodyBytes: 0, finalUrl: "", ipUsed: "" };
  });

  afterEach(() => { queued.length = 0; });
  afterAll(() => { fetchSpy.mockRestore(); });

  it("uses the delivered amount for path payments before verifying the minimum", async () => {
    queued.push(
      new Response(JSON.stringify({
        successful: true,
        memo_type: "text",
        memo: intent.intentId,
        _links: { operations: { href: "ignored" } },
      }), { status: 200 }),
      new Response(JSON.stringify({ _embedded: { records: [{
        type: "path_payment_strict_send",
        to: intent.user,
        asset_type: "native",
        destination_amount: "1.3",
        amount: "2.0",
      }] } }), { status: 200 }),
    );

    await expect(service.verify("a".repeat(64), intent)).resolves.toEqual({
      status: "verified",
      deliveredAmount: "13000000",
      operation: "path_payment_strict_send",
    });
  });

  it("keeps a transaction not yet indexed by Horizon retryable", async () => {
    queued.push(new Response("{}", { status: 404 }));
    await expect(service.verify("b".repeat(64), intent)).resolves.toEqual({
      status: "pending",
      reason: "not_indexed",
    });
  });

  it("rejects a successful transaction without the intent binding memo", async () => {
    queued.push(new Response(JSON.stringify({
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
