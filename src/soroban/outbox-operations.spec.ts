import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { Intent } from "../intents/intents.types";
import {
  acceptIntentEntry,
  buildOutboxInvocation,
  cancelIntentEntry,
  createIntentEntry,
  fillIntentEntry,
} from "./outbox-operations";
import { OutboxOperation } from "./outbox.repository";

const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USER = Keypair.random().publicKey();
const SOLVER = Keypair.random().publicKey();

const intent: Intent = {
  intentId: "11111111-2222-3333-4444-555555555555",
  user: USER,
  srcChain: "ethereum",
  srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
  srcAmount: "1000000",
  dstToken: { contract: CONTRACT_ID, symbol: "USDC", decimals: 7 },
  minDstAmount: "990000",
  state: "filled",
  createdAt: 1,
  deadline: 1_900_000_000,
  solver: SOLVER,
  fillAmount: "995000",
  txHash: "ab".repeat(32),
};

const decode = (entry: { operation: OutboxOperation; payload: Record<string, unknown> }) =>
  buildOutboxInvocation(entry, CONTRACT_ID).args.map((a) => scValToNative(a));

describe("outbox operations (#396)", () => {
  it("encodes create_intent with bigint amounts and the deadline", () => {
    const entry = createIntentEntry(intent);
    expect(entry).toMatchObject({ intentId: intent.intentId, operation: "create_intent" });
    // Payload survives a JSON round-trip (JSONB column).
    const roundTripped = { ...entry, payload: JSON.parse(JSON.stringify(entry.payload)) };
    const params = buildOutboxInvocation(roundTripped, CONTRACT_ID);
    expect(params).toMatchObject({ contractId: CONTRACT_ID, method: "create_intent" });
    expect(decode(roundTripped)).toEqual([
      intent.intentId, USER, "ethereum", "0xabc", 1_000_000n, CONTRACT_ID, 990_000n, 1_900_000_000n,
    ]);
  });

  it("encodes accept_intent, fill_intent and cancel_intent", () => {
    expect(decode(acceptIntentEntry(intent))).toEqual([intent.intentId, SOLVER, 1_900_000_000n]);
    expect(decode(fillIntentEntry(intent))).toEqual([intent.intentId, SOLVER, 995_000n, "ab".repeat(32)]);
    expect(decode(fillIntentEntry({ ...intent, txHash: undefined }))[3]).toBe("");
    expect(decode(cancelIntentEntry(intent))).toEqual([intent.intentId, USER]);
  });

  it("rejects malformed payloads so they fail at enqueue time", () => {
    expect(() => buildOutboxInvocation(acceptIntentEntry({ ...intent, solver: undefined }), CONTRACT_ID)).toThrow(
      /missing a required address/,
    );
    expect(() => buildOutboxInvocation(createIntentEntry({ ...intent, user: "nope" }), CONTRACT_ID)).toThrow();
    expect(() => buildOutboxInvocation(createIntentEntry({ ...intent, srcAmount: "1.5" }), CONTRACT_ID)).toThrow();
    expect(() =>
      buildOutboxInvocation({ operation: "bogus" as OutboxOperation, payload: {} }, CONTRACT_ID),
    ).toThrow(/unknown outbox operation/);
  });
});
