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
export function buildCancelMessage(intentId: string): string {
  return `cancel:${intentId}`;
}

/**
 * Build the canonical message that a solver must sign to accept an intent.
 */
export function buildAcceptMessage(intentId: string, solver: string): string {
  return `accept:${intentId}:${solver}`;
}

/**
 * Build the canonical message that a solver must sign to fill an intent.
 */
export function buildFillMessage(intentId: string, solver: string): string {
  return `fill:${intentId}:${solver}`;
}

/**
 * Build the canonical message that a solver must sign to register.
 */
export function buildRegisterMessage(address: string): string {
  return `register:${address}`;
}
