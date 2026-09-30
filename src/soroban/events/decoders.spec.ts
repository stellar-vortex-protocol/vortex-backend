/**
 * Unit tests for the versioned XDR event decoders.
 *
 * These tests use synthetic EventResponse objects built from the golden-file
 * fixtures in __fixtures__/events.json. The ScVal topic slots are constructed
 * using @stellar/stellar-sdk helpers so the tests exercise the real decode path
 * (not mocked scValToNative).
 */

import {
  Address,
  nativeToScVal,
  SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { decodeEvent, KNOWN_TOPICS } from "./decoders";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const KNOWN_STRKEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const SOLVER_STRKEY = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKW7MW8X2ONKGZGK6XOMP";
const CONTRACT_STRKEY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const INTENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function strTopic(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}

function addrTopic(strkey: string): xdr.ScVal {
  return Address.fromString(strkey).toScVal();
}

function makeFakeEvent(
  topics: xdr.ScVal[],
  value: xdr.ScVal,
  opts?: Partial<Pick<SorobanRpc.Api.EventResponse, "id" | "ledger" | "txHash">>,
): SorobanRpc.Api.EventResponse {
  return {
    id: opts?.id ?? "100000-0",
    ledger: opts?.ledger ?? 100000,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    txHash: opts?.txHash ?? "a".repeat(64),
    contractId: CONTRACT_STRKEY,
    type: "contract",
    pagingToken: opts?.id ?? "100000-0",
    topic: topics,
    value,
  } as unknown as SorobanRpc.Api.EventResponse;
}

function mapValue(obj: Record<string, unknown>): xdr.ScVal {
  return nativeToScVal(obj);
}

// ─── intent_registered ────────────────────────────────────────────────────────

describe("decodeEvent — intent_registered", () => {
  it("decodes a valid event", () => {
    const topics = [
      strTopic("intent_registered"),
      strTopic(INTENT_ID),
      addrTopic(KNOWN_STRKEY),
    ];
    const value = mapValue({
      src_chain: "stellar",
      src_token: "native",
      src_amount: BigInt("1000000000"),
      dst_token: Address.fromString(CONTRACT_STRKEY).toScVal(),
      min_dst_amount: BigInt("990000000"),
      deadline: BigInt("1704067200"),
    });

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("intent_registered");
    if (result.event.type !== "intent_registered") return;
    expect(result.event.payload.intentId).toBe(INTENT_ID);
    expect(result.event.payload.user).toBe(KNOWN_STRKEY);
  });
});

// ─── intent_accepted ─────────────────────────────────────────────────────────

describe("decodeEvent — intent_accepted", () => {
  it("decodes a valid event", () => {
    const topics = [
      strTopic("intent_accepted"),
      strTopic(INTENT_ID),
      addrTopic(SOLVER_STRKEY),
    ];
    const value = mapValue({ fill_deadline: BigInt("1704067320") });

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("intent_accepted");
    if (result.event.type !== "intent_accepted") return;
    expect(result.event.payload.intentId).toBe(INTENT_ID);
    expect(result.event.payload.solver).toBe(SOLVER_STRKEY);
    expect(result.event.payload.fillDeadline).toBe(BigInt("1704067320"));
  });
});

// ─── intent_filled ───────────────────────────────────────────────────────────

describe("decodeEvent — intent_filled", () => {
  it("decodes a valid event with hex tx hash", () => {
    const txHash = "deadbeef".repeat(8);
    const topics = [
      strTopic("intent_filled"),
      strTopic(INTENT_ID),
      addrTopic(SOLVER_STRKEY),
    ];
    const value = mapValue({
      fill_amount: BigInt("995000000"),
      fee_amount: BigInt("5000000"),
      tx_hash: txHash,
    });

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("intent_filled");
    if (result.event.type !== "intent_filled") return;
    expect(result.event.payload.fillAmount).toBe(BigInt("995000000"));
    expect(result.event.payload.txHash).toBe(txHash);
  });
});

// ─── intent_cancelled ────────────────────────────────────────────────────────

describe("decodeEvent — intent_cancelled", () => {
  it("decodes a valid event", () => {
    const intentId = "660e8400-e29b-41d4-a716-446655440001";
    const topics = [
      strTopic("intent_cancelled"),
      strTopic(intentId),
      addrTopic(KNOWN_STRKEY),
    ];
    const value = mapValue({});

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("intent_cancelled");
    if (result.event.type !== "intent_cancelled") return;
    expect(result.event.payload.intentId).toBe(intentId);
    expect(result.event.payload.cancelledBy).toBe(KNOWN_STRKEY);
  });
});

// ─── solver_slashed ───────────────────────────────────────────────────────────

describe("decodeEvent — solver_slashed", () => {
  it("decodes a valid event", () => {
    const topics = [
      strTopic("solver_slashed"),
      addrTopic(SOLVER_STRKEY),
      strTopic(INTENT_ID),
    ];
    const value = mapValue({
      slash_amount: BigInt("500000000"),
      reason: "missed_fill_deadline",
    });

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("solver_slashed");
    if (result.event.type !== "solver_slashed") return;
    expect(result.event.payload.solver).toBe(SOLVER_STRKEY);
    expect(result.event.payload.slashAmount).toBe(BigInt("500000000"));
    expect(result.event.payload.reason).toBe("missed_fill_deadline");
  });
});

// ─── bond_updated ─────────────────────────────────────────────────────────────

describe("decodeEvent — bond_updated", () => {
  it("decodes a valid event with positive delta", () => {
    const topics = [strTopic("bond_updated"), addrTopic(SOLVER_STRKEY)];
    const value = mapValue({
      new_bond_amount: BigInt("1500000000"),
      delta: BigInt("500000000"),
    });

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("bond_updated");
    if (result.event.type !== "bond_updated") return;
    expect(result.event.payload.newBondAmount).toBe(BigInt("1500000000"));
    expect(result.event.payload.delta).toBe(BigInt("500000000"));
  });

  it("decodes a withdrawal (negative delta)", () => {
    const topics = [strTopic("bond_updated"), addrTopic(SOLVER_STRKEY)];
    const value = mapValue({
      new_bond_amount: BigInt("500000000"),
      delta: BigInt("-500000000"),
    });

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.event.type !== "bond_updated") return;
    expect(result.event.payload.delta).toBe(BigInt("-500000000"));
  });
});

// ─── Unknown topic ────────────────────────────────────────────────────────────

describe("decodeEvent — unknown_topic", () => {
  it("returns ok=false with reason unknown_topic", () => {
    const topics = [strTopic("some_future_event"), strTopic("data")];
    const value = mapValue({});

    const result = decodeEvent(makeFakeEvent(topics, value));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_topic");
    expect(result.rawTopic).toBe("some_future_event");
  });
});

// ─── KNOWN_TOPICS coverage ────────────────────────────────────────────────────

describe("KNOWN_TOPICS", () => {
  it("covers all six expected event types", () => {
    const expected = [
      "intent_registered",
      "intent_accepted",
      "intent_filled",
      "intent_cancelled",
      "solver_slashed",
      "bond_updated",
    ];
    for (const topic of expected) {
      expect(KNOWN_TOPICS).toContain(topic);
    }
    expect(KNOWN_TOPICS).toHaveLength(expected.length);
  });
});
