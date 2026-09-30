/**
 * Stellar keypair signature verification helper.
 *
 * Convention used throughout this project:
 *   message  = the canonical string that was signed
 *   signature = base64-encoded 64-byte Ed25519 signature produced by
 *               Keypair.sign(Buffer.from(message))
 *
 * The signer proves control of `publicKey` by supplying a valid signature
 * over the message.  We never trust a caller-supplied address alone.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";

export const INTENT_SIGNATURE_CLOCK_SKEW_SECONDS = 30;
export const MAX_INTENT_SIGNATURE_TTL_SECONDS = 900;

export interface IntentSignatureContext {
  network: string;
  nonce: string;
  expiresAt: number;
}

function canonicalPayload(payload: Record<string, string | number | null>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function buildV2IntentMessage(
  context: IntentSignatureContext,
  action: "accept" | "fill" | "cancel",
  /**
   * Build the canonical message that a solver must sign to update their mutable
   * profile fields (name / supportedChains / supportedTokens / avgFillTime).
  intentId: string,
  payload: Record<string, string | number | null>,
): string {
  const payloadHash = createHash("sha256").update(canonicalPayload(payload), "utf8").digest("hex");
  return `vortex:${context.network}:${action}:${intentId}:${context.nonce}:${context.expiresAt}:${payloadHash}`;
}

/**
 * Verify that `signature` (base64) over `message` (utf-8) was produced by
 * the private key corresponding to `publicKey` (Stellar G-address).
 *
 * Throws UnauthorizedException on any failure so callers can let it propagate
 * straight to the HTTP layer.
 */
export function verifyStellarSignature(
  publicKey: string,
  message: string,
  signature: string,
): void {
  try {
    const keypair = Keypair.fromPublicKey(publicKey);
    const messageBytes = Buffer.from(message, "utf8");
    const sigBytes = Buffer.from(signature, "base64");
    const valid = keypair.verify(messageBytes, sigBytes);
    if (!valid) {
      throw new UnauthorizedException("Signature verification failed");
    }
  } catch (err) {
    if (err instanceof UnauthorizedException) throw err;
    // Invalid public key, bad base64, etc.
    throw new UnauthorizedException("Invalid signature or public key");
  }
}

/**
 * Build the canonical message that a user must sign to cancel an intent.
 */
export function buildCancelMessage(intentId: string, context?: IntentSignatureContext, user?: string): string {
  if (context) return buildV2IntentMessage(context, "cancel", intentId, { user: user ?? "" });
  return `cancel:${intentId}`;
}

/**
 * Build the canonical message that a solver must sign to authenticate its WS connection.
 */
export function buildWsAuthMessage(solver: string, timestamp: number | string): string {
  return `solver-auth:${solver}:${String(timestamp)}`;
}

/**
 * Build the canonical message that a solver must sign to accept an intent.
 */
export function buildAcceptMessage(intentId: string, solver: string, context?: IntentSignatureContext): string {
  if (context) return buildV2IntentMessage(context, "accept", intentId, { solver });
  return `accept:${intentId}:${solver}`;
}

/**
 * Build the canonical message that a solver must sign to fill an intent.
 */
export function buildFillMessage(
  intentId: string,
  solver: string,
  context?: IntentSignatureContext,
  fill?: { fillAmount: string; txHash?: string },
): string {
  if (context) {
    return buildV2IntentMessage(context, "fill", intentId, {
      solver,
      fillAmount: fill?.fillAmount ?? "",
      txHash: fill?.txHash ?? null,
    });
  }
  return `fill:${intentId}:${solver}`;
}

/**
 * Build the canonical message that a solver must sign to register.
 */
export function buildRegisterMessage(address: string): string {
  return `register:${address}`;
}

/**
 * Build the canonical message that a solver must sign to change status.
 */
export function buildSolverStatusMessage(action: "deactivate" | "reactivate" | "deregister", address: string): string {
  return `${action}:${address}`;
}

/**
 * Build the canonical message that a solver must sign to update its own
 * mutable profile fields (name / supportedChains / supportedTokens /
 * avgFillTime — issue #273, `PATCH /api/v1/solvers/:address`).
 *
 * Signing over just the address is sufficient here: it proves control of the
 * account whose profile is being edited, and the request body is already
 * constrained by the DTO whitelist so no immutable field can ride along.
 */
export function buildUpdateSolverMessage(address: string): string {
  return `update-solver:${address}`;
}

/**
 * Build the canonical message that a solver must sign to submit a slash dispute.
 */
export function buildDisputeMessage(slashId: string, address: string, reason: string): string {
  return `dispute:${slashId}:${address}:${reason}`;
}

/**
 * Build the canonical message a reviewer must sign to move a dispute into review.
 */
export function buildDisputeReviewMessage(disputeId: string): string {
  return `dispute-review:${disputeId}`;
}

/**
 * Build the canonical message a reviewer must sign to decide a dispute.
 */
export function buildDisputeDecisionMessage(disputeId: string, resolution: string, reason: string): string {
  return `dispute-decision:${disputeId}:${resolution}:${reason}`;
}

/**
 * Build the canonical message that a solver must sign to update their mutable
 * profile fields (name / supportedChains / supportedTokens / avgFillTime).
 *
 * Signing over just the address is sufficient here: it proves control of the
 * account whose profile is being edited, and the request body is already
 * constrained by the DTO whitelist so no immutable field can ride along.
 */
export function buildUpdateSolverMessage(address: string): string {
  return `update-solver:${address}`;
}
