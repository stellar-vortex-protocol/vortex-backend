/**
 * Decoder functions: raw Soroban event → validated, typed domain events.
 *
 * Each decoder:
 *  - Accepts a raw `SorobanRpc.Api.EventResponse`
 *  - Uses `scValToNative` to convert XDR ScVals (no `any` in the decode path)
 *  - Validates the result with a Zod schema
 *  - Returns a discriminated-union `DecodedEvent`
 *
 * i128/u128 → bigint (SDK preserves bigint for those types)
 * Address   → strkey via `Address.toString()`
 * Bytes     → hex string via `Buffer.from(...).toString("hex")`
 *
 * @module soroban/events/decoders
 */

import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar/stellar-sdk";
import {
  BondUpdatedPayloadV1,
  IntentAcceptedPayloadV1,
  IntentCancelledPayloadV1,
  IntentFilledPayloadV1,
  IntentRegisteredPayloadV1,
  SolverSlashedPayloadV1,
  type BondUpdatedPayloadV1 as TBondUpdated,
  type IntentAcceptedPayloadV1 as TIntentAccepted,
  type IntentCancelledPayloadV1 as TIntentCancelled,
  type IntentFilledPayloadV1 as TIntentFilled,
  type IntentRegisteredPayloadV1 as TIntentRegistered,
  type SolverSlashedPayloadV1 as TSolverSlashed,
} from "./schemas";

// ─── Discriminated union ──────────────────────────────────────────────────────

export type DecodedEvent =
  | { type: "intent_registered"; schemaVersion: 1; ledger: number; txHash: string; payload: TIntentRegistered }
  | { type: "intent_accepted";   schemaVersion: 1; ledger: number; txHash: string; payload: TIntentAccepted }
  | { type: "intent_filled";     schemaVersion: 1; ledger: number; txHash: string; payload: TIntentFilled }
  | { type: "intent_cancelled";  schemaVersion: 1; ledger: number; txHash: string; payload: TIntentCancelled }
  | { type: "solver_slashed";    schemaVersion: 1; ledger: number; txHash: string; payload: TSolverSlashed }
  | { type: "bond_updated";      schemaVersion: 1; ledger: number; txHash: string; payload: TBondUpdated };

export type DecodeResult =
  | { ok: true;  event: DecodedEvent }
  | { ok: false; reason: "unknown_topic"; rawTopic: string }
  | { ok: false; reason: "decode_error";  rawTopic: string; error: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely convert a single ScVal XDR base64 or a pre-parsed xdr.ScVal to its
 * native JS equivalent without throwing. Returns `undefined` on failure.
 */
function safeNative(scVal: xdr.ScVal): unknown {
  try {
    return scValToNative(scVal);
  } catch {
    return undefined;
  }
}

/**
 * Convert an Address ScVal to its strkey string (G… or C…).
 * Throws if the value is not an Address.
 */
function addressToStrkey(scVal: xdr.ScVal): string {
  return Address.fromScVal(scVal).toString();
}

/**
 * Convert a Bytes ScVal to a lowercase hex string.
 * Throws if the value is not bytes.
 */
function bytesToHex(scVal: xdr.ScVal): string {
  const raw = scVal.bytes();
  return Buffer.from(raw).toString("hex");
}

/** Parse schema version from an optional topic slot (default 1). */
function parseSchemaVersion(raw: unknown): 1 {
  // For now we only have version 1; future versions add more branches here.
  if (raw === undefined || raw === null || raw === "1" || raw === 1) return 1;
  return 1;
}

// ─── Per-topic decoders ───────────────────────────────────────────────────────

function decodeIntentRegistered(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent {
  const t = event.topic;
  // topic: [name, intentId, user]
  // contractData (body): { srcChain, srcToken, srcAmount, dstToken, minDstAmount, deadline }
  const body = safeNative(event.value) as Record<string, unknown>;

  const raw = {
    intentId:     safeNative(t[1]) as string,
    user:         addressToStrkey(t[2]),
    srcChain:     body?.src_chain as string,
    srcToken:     body?.src_token as string,
    srcAmount:    body?.src_amount as bigint,
    dstToken:     addressToStrkey(
                    xdr.ScVal.fromXDR(Buffer.from(String(body?.dst_token ?? ""), "base64")),
                  ),
    minDstAmount: body?.min_dst_amount as bigint,
    deadline:     body?.deadline as bigint,
  };

  const payload = IntentRegisteredPayloadV1.parse(raw);
  return {
    type: "intent_registered",
    schemaVersion: 1,
    ledger: event.ledger,
    txHash: event.txHash,
    payload,
  };
}

function decodeIntentAccepted(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent {
  const t = event.topic;
  const body = safeNative(event.value) as Record<string, unknown>;

  const raw = {
    intentId:     safeNative(t[1]) as string,
    solver:       addressToStrkey(t[2]),
    fillDeadline: (body?.fill_deadline ?? body?.fillDeadline) as bigint,
  };

  const payload = IntentAcceptedPayloadV1.parse(raw);
  return {
    type: "intent_accepted",
    schemaVersion: 1,
    ledger: event.ledger,
    txHash: event.txHash,
    payload,
  };
}

function decodeIntentFilled(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent {
  const t = event.topic;
  const body = safeNative(event.value) as Record<string, unknown>;

  const raw = {
    intentId:   safeNative(t[1]) as string,
    solver:     addressToStrkey(t[2]),
    fillAmount: (body?.fill_amount ?? body?.fillAmount) as bigint,
    feeAmount:  (body?.fee_amount  ?? body?.feeAmount)  as bigint,
    txHash:     typeof body?.tx_hash === "string"
                  ? body.tx_hash
                  : bytesToHex(
                      xdr.ScVal.fromXDR(Buffer.from(String(body?.tx_hash ?? ""), "base64")),
                    ),
  };

  const payload = IntentFilledPayloadV1.parse(raw);
  return {
    type: "intent_filled",
    schemaVersion: 1,
    ledger: event.ledger,
    txHash: event.txHash,
    payload,
  };
}

function decodeIntentCancelled(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent {
  const t = event.topic;

  const raw = {
    intentId:    safeNative(t[1]) as string,
    cancelledBy: addressToStrkey(t[2]),
  };

  const payload = IntentCancelledPayloadV1.parse(raw);
  return {
    type: "intent_cancelled",
    schemaVersion: 1,
    ledger: event.ledger,
    txHash: event.txHash,
    payload,
  };
}

function decodeSolverSlashed(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent {
  const t = event.topic;
  const body = safeNative(event.value) as Record<string, unknown>;

  const raw = {
    solver:      addressToStrkey(t[1]),
    intentId:    safeNative(t[2]) as string,
    slashAmount: (body?.slash_amount ?? body?.slashAmount) as bigint,
    reason:      (body?.reason ?? "no_reason_provided") as string,
  };

  const payload = SolverSlashedPayloadV1.parse(raw);
  return {
    type: "solver_slashed",
    schemaVersion: 1,
    ledger: event.ledger,
    txHash: event.txHash,
    payload,
  };
}

function decodeBondUpdated(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent {
  const t = event.topic;
  const body = safeNative(event.value) as Record<string, unknown>;

  const raw = {
    solver:        addressToStrkey(t[1]),
    newBondAmount: (body?.new_bond_amount ?? body?.newBondAmount) as bigint,
    delta:         (body?.delta) as bigint,
  };

  const payload = BondUpdatedPayloadV1.parse(raw);
  return {
    type: "bond_updated",
    schemaVersion: 1,
    ledger: event.ledger,
    txHash: event.txHash,
    payload,
  };
}

// ─── Dispatcher map ───────────────────────────────────────────────────────────

type TopicDecoder = (event: SorobanRpc.Api.EventResponse) => DecodedEvent;

const DECODERS: Readonly<Record<string, TopicDecoder>> = {
  intent_registered: decodeIntentRegistered,
  intent_accepted:   decodeIntentAccepted,
  intent_filled:     decodeIntentFilled,
  intent_cancelled:  decodeIntentCancelled,
  solver_slashed:    decodeSolverSlashed,
  bond_updated:      decodeBondUpdated,
};

export const KNOWN_TOPICS = Object.keys(DECODERS) as ReadonlyArray<string>;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a raw Soroban event into a typed `DecodedEvent`.
 *
 * @returns `{ ok: true, event }` on success.
 *          `{ ok: false, reason: "unknown_topic" }` when the topic is not in
 *            the registry — callers should count and log, never throw.
 *          `{ ok: false, reason: "decode_error" }` for known topics that fail
 *            schema validation — callers should route to the dead-letter table.
 */
export function decodeEvent(event: SorobanRpc.Api.EventResponse): DecodeResult {
  // topic[0] carries the event name
  let rawTopic = "<empty>";
  try {
    rawTopic = String(safeNative(event.topic[0]) ?? "<empty>");
  } catch {
    // leave rawTopic as "<empty>"
  }

  const decoder = DECODERS[rawTopic];
  if (!decoder) {
    return { ok: false, reason: "unknown_topic", rawTopic };
  }

  try {
    const decoded = decoder(event);
    return { ok: true, event: decoded };
  } catch (err) {
    return {
      ok: false,
      reason: "decode_error",
      rawTopic,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-export parseSchemaVersion for registry use
export { parseSchemaVersion };
