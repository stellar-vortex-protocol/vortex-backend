/**
 * Zod schemas for every versioned Soroban contract event payload.
 *
 * Topic-based versioning: topic[0] is the event name, topic[1] is an optional
 * semver string like "1" or "1.0". When absent we default to schema version 1.
 *
 * All i128/u128 values arrive as bigint from scValToNative and are kept as
 * bigint throughout the domain model. Address ScVals are decoded to strkeys
 * (G… / C…). Bytes txHash values are hex strings.
 *
 * @module soroban/events/schemas
 */

import { z } from "zod";

// ─── Primitive refiners ───────────────────────────────────────────────────────

/** Non-negative bigint — covers u128 / u64 amounts */
const nonNegBigInt = z.bigint().refine((v) => v >= 0n, { message: "must be non-negative" });

/** Stellar strkey — G…(public key) or C…(contract) */
const strkey = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, "must be a valid Stellar strkey");

/** 64-char hex string — decoded from a Bytes ScVal txHash */
const hexBytes = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex string");

// ─── Settlement contract events (topic[0]) ───────────────────────────────────

/**
 * IntentRegistered — emitted when a new intent is stored in the settlement contract.
 *
 * Topic layout:
 *   [0] "intent_registered"
 *   [1] intentId  (string)
 *   [2] user      (Address → strkey)
 */
export const IntentRegisteredPayloadV1 = z.object({
  intentId: z.string().uuid(),
  user: strkey,
  srcChain: z.string().min(1),
  srcToken: z.string().min(1),
  srcAmount: nonNegBigInt,
  dstToken: strkey,
  minDstAmount: nonNegBigInt,
  deadline: nonNegBigInt,
});

export type IntentRegisteredPayloadV1 = z.infer<typeof IntentRegisteredPayloadV1>;

/**
 * IntentAccepted — emitted when a solver locks in on an intent.
 *
 * Topic layout:
 *   [0] "intent_accepted"
 *   [1] intentId (string)
 *   [2] solver   (Address → strkey)
 */
export const IntentAcceptedPayloadV1 = z.object({
  intentId: z.string().uuid(),
  solver: strkey,
  fillDeadline: nonNegBigInt,
});

export type IntentAcceptedPayloadV1 = z.infer<typeof IntentAcceptedPayloadV1>;

/**
 * IntentFilled — emitted once a solver's fill is confirmed on-chain.
 *
 * Topic layout:
 *   [0] "intent_filled"
 *   [1] intentId   (string)
 *   [2] solver     (Address → strkey)
 */
export const IntentFilledPayloadV1 = z.object({
  intentId: z.string().uuid(),
  solver: strkey,
  fillAmount: nonNegBigInt,
  feeAmount: nonNegBigInt,
  txHash: hexBytes,
});

export type IntentFilledPayloadV1 = z.infer<typeof IntentFilledPayloadV1>;

/**
 * IntentCancelled — emitted when a user or the protocol cancels an open intent.
 *
 * Topic layout:
 *   [0] "intent_cancelled"
 *   [1] intentId (string)
 */
export const IntentCancelledPayloadV1 = z.object({
  intentId: z.string().uuid(),
  cancelledBy: strkey,
});

export type IntentCancelledPayloadV1 = z.infer<typeof IntentCancelledPayloadV1>;

// ─── Solver-registry contract events ─────────────────────────────────────────

/**
 * SolverSlashed — emitted when a solver's bond is partially slashed.
 *
 * Topic layout:
 *   [0] "solver_slashed"
 *   [1] solver   (Address → strkey)
 *   [2] intentId (string)
 */
export const SolverSlashedPayloadV1 = z.object({
  solver: strkey,
  intentId: z.string().uuid(),
  slashAmount: nonNegBigInt,
  reason: z.string().min(1),
});

export type SolverSlashedPayloadV1 = z.infer<typeof SolverSlashedPayloadV1>;

/**
 * BondUpdated — emitted when a solver's bond deposit or withdrawal is processed.
 *
 * Topic layout:
 *   [0] "bond_updated"
 *   [1] solver (Address → strkey)
 */
export const BondUpdatedPayloadV1 = z.object({
  solver: strkey,
  /** New total bond amount after the update. */
  newBondAmount: nonNegBigInt,
  /** Signed delta: positive = deposit, negative = withdrawal. */
  delta: z.bigint(),
});

export type BondUpdatedPayloadV1 = z.infer<typeof BondUpdatedPayloadV1>;
