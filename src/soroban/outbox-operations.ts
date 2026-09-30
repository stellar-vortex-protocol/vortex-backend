import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { Intent } from "../intents/intents.types";
import type { NewOutboxEntry, OutboxOperation } from "./outbox.repository";
import type { InvokeContractParams } from "./stellar-tx.service";

/**
 * Payload builders and ScVal encoders for settlement-contract operations that
 * flow through the outbox (issue #396).
 *
 * Payloads are plain JSON (bigint amounts as strings) so they survive the
 * `payload JSONB` column; ScVal encoding happens at relay time. The contract
 * method names follow docs/architecture/onchain-settlement.md and stay
 * provisional until the settlement ADR (issue #19) fixes the interface.
 */

export function createIntentEntry(intent: Intent): NewOutboxEntry {
  return {
    intentId: intent.intentId,
    operation: "create_intent",
    payload: {
      intentId: intent.intentId,
      user: intent.user,
      srcChain: intent.srcChain,
      srcTokenAddress: intent.srcToken.address,
      srcAmount: intent.srcAmount,
      dstTokenContract: intent.dstToken.contract,
      minDstAmount: intent.minDstAmount,
      deadline: intent.deadline,
    },
  };
}

export function acceptIntentEntry(intent: Intent): NewOutboxEntry {
  return {
    intentId: intent.intentId,
    operation: "accept_intent",
    payload: { intentId: intent.intentId, solver: intent.solver, fillDeadline: intent.deadline },
  };
}

export function fillIntentEntry(intent: Intent): NewOutboxEntry {
  return {
    intentId: intent.intentId,
    operation: "fill_intent",
    payload: {
      intentId: intent.intentId,
      solver: intent.solver,
      fillAmount: intent.fillAmount,
      fillTxHash: intent.txHash ?? "",
    },
  };
}

export function cancelIntentEntry(intent: Intent): NewOutboxEntry {
  return {
    intentId: intent.intentId,
    operation: "cancel_intent",
    payload: { intentId: intent.intentId, user: intent.user },
  };
}

/**
 * Encodes an outbox payload as a contract invocation.
 *
 * @throws on a malformed payload (bad address, non-integer amount). Callers
 *         run this at enqueue time too, so bad input fails the HTTP request
 *         instead of becoming a poison row.
 */
export function buildOutboxInvocation(
  entry: { operation: OutboxOperation; payload: Record<string, unknown> },
  settlementContractId: string,
): InvokeContractParams {
  const p = entry.payload;
  let args: xdr.ScVal[];
  switch (entry.operation) {
    case "create_intent":
      args = [
        str(p.intentId),
        address(p.user),
        nativeToScVal(String(p.srcChain), { type: "symbol" }),
        str(p.srcTokenAddress),
        i128(p.srcAmount),
        address(p.dstTokenContract),
        i128(p.minDstAmount),
        nativeToScVal(Number(p.deadline), { type: "u64" }),
      ];
      break;
    case "accept_intent":
      args = [str(p.intentId), address(p.solver), nativeToScVal(Number(p.fillDeadline), { type: "u64" })];
      break;
    case "fill_intent":
      args = [str(p.intentId), address(p.solver), i128(p.fillAmount), str(p.fillTxHash)];
      break;
    case "cancel_intent":
      args = [str(p.intentId), address(p.user)];
      break;
    default: {
      const unknown: never = entry.operation;
      throw new Error(`unknown outbox operation: ${String(unknown)}`);
    }
  }
  return { contractId: settlementContractId, method: entry.operation, args };
}

function str(value: unknown): xdr.ScVal {
  return nativeToScVal(String(value ?? ""), { type: "string" });
}

function address(value: unknown): xdr.ScVal {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("outbox payload is missing a required address");
  }
  return new Address(value).toScVal();
}

function i128(value: unknown): xdr.ScVal {
  return nativeToScVal(BigInt(String(value)), { type: "i128" });
}
