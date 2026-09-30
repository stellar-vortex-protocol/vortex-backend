/**
 * Zod schemas for every WebSocket frame (issue #456).
 *
 * Two layers of validation exist for the protocol and they are deliberately
 * separate:
 *
 *   1. `docs/asyncapi.yaml` — the contract. It is served at `/docs/ws`,
 *      generates `src/generated/ws-api-types.ts`, and is enforced against
 *      frames captured on the wire by `test/asyncapi-contract.e2e-spec.ts`.
 *   2. The schemas below — a fast, dependency-light mirror used to validate
 *      messages **in development and test only** (see
 *      {@link wsValidationEnabled}).
 *
 * Validation is *advisory*: a mismatch is logged as `ws invalid …` but never
 * changes what is sent or handled, so enabling it cannot break a running
 * system. That keeps the "no breaking WS changes" guarantee while still
 * surfacing spec drift the moment a frame stops matching its schema.
 *
 * `ws-schemas.spec.ts` asserts that every frame type registered here has a
 * matching `components.schemas` entry in the AsyncAPI document, so the two
 * layers cannot drift apart silently.
 */

import { z } from "zod";
import { INTENT_STATES, SUPPORTED_CHAINS } from "../intents/intents.types";

/**
 * Whether message validation runs.
 *
 * Enabled everywhere except `NODE_ENV=production`, i.e. exactly the
 * development and test environments the issue asks for. Read on every call so
 * tests (and `NODE_ENV` toggles) take effect immediately.
 */
export function wsValidationEnabled(): boolean {
  return (process.env.NODE_ENV ?? "development") !== "production";
}

const chainSchema = z.enum(SUPPORTED_CHAINS);

const tokenInfoSchema = z
  .object({
    address: z.string(),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int(),
    chain: chainSchema,
    logoURI: z.string().optional(),
    priceUSD: z.number().optional(),
  })
  .passthrough();

const stellarTokenSchema = z
  .object({
    contract: z.string(),
    symbol: z.string(),
    decimals: z.number().int(),
    priceUSD: z.number().optional(),
  })
  .passthrough();

/**
 * Intent payload. Mirrors `components.schemas.Intent`: the required core is
 * checked, unknown keys are tolerated (the AsyncAPI document tells clients to
 * ignore fields they do not know).
 */
const intentSchema = z
  .object({
    intentId: z.string(),
    user: z.string(),
    srcChain: chainSchema,
    srcToken: tokenInfoSchema,
    srcAmount: z.string(),
    dstToken: stellarTokenSchema,
    minDstAmount: z.string(),
    state: z.enum(INTENT_STATES),
    createdAt: z.number().int(),
    deadline: z.number().int(),
    quotedDstAmount: z.string().optional(),
    solver: z.string().optional(),
    filledAt: z.number().int().optional(),
    fillAmount: z.string().optional(),
    feeAmount: z.string().optional(),
    txHash: z.string().optional(),
    slashedAt: z.number().int().optional(),
    slashReason: z.string().optional(),
    paramsVersion: z.number().int().optional(),
  })
  .passthrough();

const seqSchema = z.number().int().min(0);

/** Frames the gateway sends to a client, keyed by their wire `type`. */
export const serverFrameSchemas = {
  connected: z
    .object({
      type: z.literal("connected"),
      message: z.string(),
      seq: seqSchema,
      protocol: z.string(),
    })
    .strict(),
  snapshot: z
    .object({
      type: z.literal("snapshot"),
      intents: z.array(intentSchema).max(20),
      seq: seqSchema,
    })
    .strict(),
  subscribed: z
    .object({
      type: z.literal("subscribed"),
      filter: z
        .object({
          all: z.boolean().optional(),
          chains: z.array(chainSchema).optional(),
        })
        .strict(),
    })
    .strict(),
  subscribe_rejected: z
    .object({ type: z.literal("subscribe_rejected"), reason: z.string() })
    .strict(),
  replay_start: z
    .object({
      type: z.literal("replay_start"),
      fromSeq: z.number().int().min(0),
      count: z.number().int().min(0),
    })
    .strict(),
  replay_end: z
    .object({ type: z.literal("replay_end"), count: z.number().int().min(0) })
    .strict(),
  replay_too_old: z
    .object({
      type: z.literal("replay_too_old"),
      fromSeq: z.number().int().min(0),
      oldestAvailableSeq: z.number().int().min(1),
    })
    .strict(),
  auth_ok: z.object({ type: z.literal("auth_ok") }).strict(),
  auth_error: z
    .object({
      type: z.literal("auth_error"),
      reason: z.string(),
    })
    .strict(),
  eligible_snapshot: z
    .object({
      type: z.literal("eligible_snapshot"),
      intents: z.array(intentSchema),
      count: z.number().int().min(0),
    })
    .strict(),
  intent_created: z
    .object({ type: z.literal("intent_created"), seq: z.number().int().min(1), intent: intentSchema })
    .strict(),
  intent_accepted: z
    .object({
      type: z.literal("intent_accepted"),
      seq: z.number().int().min(1),
      intentId: z.string(),
      solver: z.string(),
    })
    .strict(),
  intent_filled: z
    .object({
      type: z.literal("intent_filled"),
      seq: z.number().int().min(1),
      intentId: z.string(),
      solver: z.string(),
      fillAmount: z.string(),
    })
    .strict(),
  intent_cancelled: z
    .object({
      type: z.literal("intent_cancelled"),
      seq: z.number().int().min(1),
      intentId: z.string(),
    })
    .strict(),
  intent_expired: z
    .object({
      type: z.literal("intent_expired"),
      seq: z.number().int().min(1),
      intentId: z.string(),
    })
    .strict(),
  intent_slashed: z
    .object({
      type: z.literal("intent_slashed"),
      seq: z.number().int().min(1),
      intentId: z.string(),
      solver: z.string().nullish(),
      reason: z.string(),
    })
    .strict(),
  protocol_status: z
    .object({
      type: z.literal("protocol_status"),
      seq: z.number().int().min(1),
      action: z.enum(["paused", "resumed"]),
      scope: z.enum(["global", "chain", "token", "operation"]),
      chain: z.string().nullable(),
      token: z.string().nullable(),
      operation: z.string().nullable(),
      reasonCode: z.string(),
      reason: z.string(),
      paused: z.boolean(),
    })
    .strict(),
} satisfies Record<string, z.ZodTypeAny>;

/** Frames a client may send, keyed by their wire `type`. */
export const clientMessageSchemas = {
  subscribe: z
    .object({
      type: z.literal("subscribe"),
      chains: z.array(z.string()).optional(),
      all: z.boolean().optional(),
    })
    .strict(),
  replay: z
    .object({ type: z.literal("replay"), fromSeq: z.number().int().min(0) })
    .strict(),
  auth: z
    .object({
      type: z.literal("auth"),
      solver: z.string(),
      timestamp: z.number().int(),
      signature: z.string(),
    })
    .strict(),
} satisfies Record<string, z.ZodTypeAny>;

export type ServerFrameType = keyof typeof serverFrameSchemas;
export type ClientMessageType = keyof typeof clientMessageSchemas;

/**
 * `components.schemas` name for every registered frame, used to tie the
 * runtime schemas to `docs/asyncapi.yaml` in tests and in the contract test.
 */
export const serverFrameSchemaNames: Record<ServerFrameType, string> = {
  connected: "Connected",
  snapshot: "Snapshot",
  subscribed: "Subscribed",
  subscribe_rejected: "SubscribeRejected",
  replay_start: "ReplayStart",
  replay_end: "ReplayEnd",
  replay_too_old: "ReplayTooOld",
  auth_ok: "AuthOk",
  auth_error: "AuthError",
  eligible_snapshot: "EligibleSnapshot",
  intent_created: "IntentCreated",
  intent_accepted: "IntentAccepted",
  intent_filled: "IntentFilled",
  intent_cancelled: "IntentCancelled",
  intent_expired: "IntentExpired",
  intent_slashed: "IntentSlashed",
  protocol_status: "ProtocolStatus",
};

/** `components.schemas` name for every client message. */
export const clientMessageSchemaNames: Record<ClientMessageType, string> = {
  subscribe: "SubscribeMessage",
  replay: "ReplayMessage",
  auth: "AuthMessage",
};

export interface ValidationResult {
  ok: boolean;
  /** Human-readable description of the first violation (only when `!ok`). */
  error?: string;
  /**
   * True when no schema is registered for this `type` — the frame is simply
   * outside the documented protocol (the gateway accepts arbitrary broadcast
   * event types) and nothing was checked.
   */
  skipped?: boolean;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Validate an outbound frame against its schema.
 *
 * @param frame - The frame about to be serialised. Frame types without a
 *   registered schema are skipped (see {@link ValidationResult.skipped}).
 */
export function validateServerFrame(frame: unknown): ValidationResult {
  if (typeof frame !== "object" || frame === null) {
    return { ok: false, error: "frame is not a JSON object" };
  }
  const type = (frame as { type?: unknown }).type;
  if (typeof type !== "string") {
    return { ok: false, error: "frame has no string `type` field" };
  }
  const schema = serverFrameSchemas[type as ServerFrameType];
  if (!schema) return { ok: true, skipped: true };

  const result = schema.safeParse(frame);
  return result.success ? { ok: true } : { ok: false, error: formatIssues(result.error) };
}

/** Validate an inbound client message against its schema. */
export function validateClientMessage(message: unknown): ValidationResult {
  if (typeof message !== "object" || message === null) {
    return { ok: false, error: "message is not a JSON object" };
  }
  const type = (message as { type?: unknown }).type;
  if (typeof type !== "string") {
    return { ok: false, error: "message has no string `type` field" };
  }
  const schema = clientMessageSchemas[type as ClientMessageType];
  // Unknown message types are ignored by the gateway by design; that is not a
  // protocol violation, so there is nothing to validate.
  if (!schema) return { ok: true, skipped: true };

  const result = schema.safeParse(message);
  return result.success ? { ok: true } : { ok: false, error: formatIssues(result.error) };
}
