import { Keypair } from "@stellar/stellar-sdk";
import { createHash, randomBytes } from "node:crypto";

export interface IntentSignatureOptions {
  network: "testnet" | "futurenet" | "mainnet";
  nonce?: string;
  expiresAt?: number;
}

function v2Message(
  action: "accept" | "fill" | "cancel",
  intentId: string,
  context: Required<IntentSignatureOptions>,
  payload: Record<string, string | null>,
): string {
  const canonicalPayload = JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))),
  );
  const payloadHash = createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
  return `vortex:${context.network}:${action}:${intentId}:${context.nonce}:${context.expiresAt}:${payloadHash}`;
}

export const messagesV2 = {
  accept: (intentId: string, solver: string, context: Required<IntentSignatureOptions>) =>
    v2Message("accept", intentId, context, { solver }),
  fill: (
    intentId: string,
    solver: string,
    fillAmount: string,
    txHash: string | undefined,
    context: Required<IntentSignatureOptions>,
  ) => v2Message("fill", intentId, context, { solver, fillAmount, txHash: txHash ?? null }),
  cancel: (intentId: string, user: string, context: Required<IntentSignatureOptions>) =>
    v2Message("cancel", intentId, context, { user }),
};

function resolveSignatureOptions(options: IntentSignatureOptions) {
  return {
    network: options.network,
    nonce: options.nonce ?? randomBytes(16).toString("base64url"),
    expiresAt: options.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
  };
}

/**
 * Canonical messages — byte-for-byte identical to the server's builders in
 * src/common/stellar-signature.ts. The shared vectors in
 * test-vectors/signatures.json are checked on both sides.
 */
export const messages = {
  accept: (intentId: string, solver: string) => `accept:${intentId}:${solver}`,
  fill: (intentId: string, solver: string) => `fill:${intentId}:${solver}`,
  cancel: (intentId: string) => `cancel:${intentId}`,
  wsAuth: (solver: string, timestamp: number | string) => `solver-auth:${solver}:${String(timestamp)}`,
  register: (address: string) => `register:${address}`,
};

/** Ed25519 signature over the UTF-8 message, base64-encoded (the server's format). */
export function signMessage(keypair: Keypair, message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

/** Body for POST /api/v1/intents/{id}/accept. */
export function signAccept(keypair: Keypair, intentId: string, options?: IntentSignatureOptions) {
  const solver = keypair.publicKey();
  if (!options) return { solver, signature: signMessage(keypair, messages.accept(intentId, solver)) };
  const context = resolveSignatureOptions(options);
  return {
    solver,
    ...context,
    signature: signMessage(keypair, messagesV2.accept(intentId, solver, context)),
  };
}

/** Body for POST /api/v1/intents/{id}/fill. */
export function signFill(
  keypair: Keypair,
  intentId: string,
  fillAmount: string,
  txHash?: string,
  options?: IntentSignatureOptions,
) {
  const solver = keypair.publicKey();
  if (options) {
    const context = resolveSignatureOptions(options);
    return {
      solver,
      fillAmount,
      ...(txHash !== undefined ? { txHash } : {}),
      ...context,
      signature: signMessage(
        keypair,
        messagesV2.fill(intentId, solver, fillAmount, txHash, context),
      ),
    };
  }
  return {
    solver,
    fillAmount,
    ...(txHash ? { txHash } : {}),
    signature: signMessage(keypair, messages.fill(intentId, solver)),
  };
}

/** Body for POST /api/v1/intents/{id}/cancel (signed by the intent's user). */
export function signCancel(keypair: Keypair, intentId: string, options?: IntentSignatureOptions) {
  const user = keypair.publicKey();
  if (!options) return { user, signature: signMessage(keypair, messages.cancel(intentId)) };
  const context = resolveSignatureOptions(options);
  return { user, ...context, signature: signMessage(keypair, messagesV2.cancel(intentId, user, context)) };
}

/** WS `{ type: "auth" }` frame. */
export function signWsAuth(keypair: Keypair, timestamp = Math.floor(Date.now() / 1000)) {
  const solver = keypair.publicKey();
  return { type: "auth" as const, solver, timestamp, signature: signMessage(keypair, messages.wsAuth(solver, timestamp)) };
}
