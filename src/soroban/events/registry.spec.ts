/**
 * Unit tests for EventDecoderRegistry.
 *
 * Verifies unknown-topic counting, dead-letter routing, and batch processing.
 */

import {
  Address,
  nativeToScVal,
  SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { EventDecoderRegistry, type DeadLetterEntry } from "./registry";

const SOLVER_STRKEY = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKW7MW8X2ONKGZGK6XOMP";
const INTENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function str(s: string): xdr.ScVal { return nativeToScVal(s, { type: "string" }); }
function addr(k: string): xdr.ScVal { return Address.fromString(k).toScVal(); }

function fakeEvent(
  topics: xdr.ScVal[],
  value: xdr.ScVal,
  id = "100-0",
): SorobanRpc.Api.EventResponse {
  return {
    id,
    ledger: 100,
    ledgerClosedAt: "",
    txHash: "a".repeat(64),
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
    type: "contract",
    pagingToken: id,
    topic: topics,
    value,
  } as unknown as SorobanRpc.Api.EventResponse;
}

describe("EventDecoderRegistry", () => {
  it("calls onEvent for a successfully decoded event", async () => {
    const received: string[] = [];
    const registry = new EventDecoderRegistry({
      onEvent: async (e) => { received.push(e.type); },
    });

    const topics = [
      str("solver_slashed"),
      addr(SOLVER_STRKEY),
      str(INTENT_ID),
    ];
    const value = nativeToScVal({ slash_amount: BigInt("100"), reason: "test" });

    await registry.process(fakeEvent(topics, value));
    expect(received).toContain("solver_slashed");
    expect(registry.getStats().processed).toBe(1);
  });

  it("counts unknown topics without throwing", async () => {
    const registry = new EventDecoderRegistry({ onEvent: async () => {} });

    const topics = [str("not_a_real_topic"), str("data")];
    const result = await registry.process(fakeEvent(topics, nativeToScVal({})));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_topic");
    expect(registry.getStats().unknownTopic).toBe(1);
    expect(registry.getUnknownTopicCounts().get("not_a_real_topic")).toBe(1);
  });

  it("routes malformed known topics to dead-letter sink", async () => {
    const deadLetters: DeadLetterEntry[] = [];
    const registry = new EventDecoderRegistry({
      onEvent: async () => {},
      onDeadLetter: async (entry) => { deadLetters.push(entry); },
    });

    // intent_filled with missing required fields → Zod parse error
    const topics = [str("intent_filled"), str("not-a-uuid"), addr(SOLVER_STRKEY)];
    const value = nativeToScVal({ fill_amount: BigInt("0"), fee_amount: BigInt("0"), tx_hash: "bad" });

    await registry.process(fakeEvent(topics, value));

    expect(registry.getStats().decodeErrors).toBe(1);
    expect(registry.getStats().deadLettered).toBe(1);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].rawTopic).toBe("intent_filled");
  });

  it("processBatch returns correct ok/error counts", async () => {
    const registry = new EventDecoderRegistry({ onEvent: async () => {} });

    const goodEvent = fakeEvent(
      [str("bond_updated"), addr(SOLVER_STRKEY)],
      nativeToScVal({ new_bond_amount: BigInt("100"), delta: BigInt("50") }),
      "101-0",
    );
    const unknownEvent = fakeEvent([str("mystery_event")], nativeToScVal({}), "102-0");

    const { ok, errors } = await registry.processBatch([goodEvent, unknownEvent]);
    expect(ok).toBe(1);
    expect(errors).toBe(1);
  });

  it("does not throw when onEvent handler throws", async () => {
    const registry = new EventDecoderRegistry({
      onEvent: async () => { throw new Error("handler crash"); },
    });

    const topics = [
      str("bond_updated"),
      addr(SOLVER_STRKEY),
    ];
    const value = nativeToScVal({ new_bond_amount: BigInt("1"), delta: BigInt("1") });

    // Should not throw
    await expect(registry.process(fakeEvent(topics, value))).resolves.not.toThrow();
    // Event was still decoded successfully
    expect(registry.getStats().processed).toBe(1);
  });

  it("accumulates unknown topic counts across multiple calls", async () => {
    const registry = new EventDecoderRegistry({ onEvent: async () => {} });

    for (let i = 0; i < 5; i++) {
      await registry.process(fakeEvent([str("future_event")], nativeToScVal({}), `${i}-0`));
    }

    expect(registry.getUnknownTopicCounts().get("future_event")).toBe(5);
    expect(registry.getStats().unknownTopic).toBe(5);
  });
});
