import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Asset } from "@stellar/stellar-sdk";
import { AppConfig, NETWORK_PASSPHRASES } from "../config/configuration";
import { Intent } from "../intents/intents.types";

/** A structured independent verdict for a submitted Stellar fill transaction. */
export type FillVerificationVerdict =
  | { status: "verified"; deliveredAmount: string; operation: string }
  | { status: "pending"; reason: "not_indexed" | "horizon_unavailable" }
  | { status: "rejected"; reason: string };

type HorizonTransaction = {
  successful?: boolean;
  memo_type?: string;
  memo?: string;
  _links?: { operations?: { href?: string } };
};

/** Independently checks Horizon's indexed Stellar transaction and payment operations. */
@Injectable()
export class FillVerifierService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * Verify the transaction against the persisted intent. Unknown/indexing errors
   * remain retryable; malformed or mismatched transactions are definitive.
   */
  async verify(txHash: string, intent: Intent): Promise<FillVerificationVerdict> {
    const base = this.config.get("stellar.horizonUrl", { infer: true }).replace(/\/$/, "");
    let transaction: HorizonTransaction;
    try {
      const response = await fetch(`${base}/transactions/${encodeURIComponent(txHash)}`);
      if (response.status === 404) return { status: "pending", reason: "not_indexed" };
      if (!response.ok) return { status: "pending", reason: "horizon_unavailable" };
      transaction = (await response.json()) as HorizonTransaction;
    } catch {
      return { status: "pending", reason: "horizon_unavailable" };
    }

    if (transaction.successful !== true) return { status: "rejected", reason: "transaction_failed" };
    if (transaction.memo_type !== "text" || transaction.memo !== intent.intentId) {
      return { status: "rejected", reason: "intent_memo_mismatch" };
    }
    if (!transaction._links?.operations?.href) return { status: "rejected", reason: "operations_missing" };
    try {
      const response = await fetch(`${base}/transactions/${encodeURIComponent(txHash)}/operations?limit=200&order=asc`);
      if (!response.ok) return { status: "pending", reason: "horizon_unavailable" };
      const body = (await response.json()) as { _embedded?: { records?: Array<Record<string, unknown>> } };
      const operations = body._embedded?.records ?? [];
      for (const operation of operations) {
        const type = operation.type as string;
        if (!["payment", "path_payment_strict_send", "path_payment_strict_receive"].includes(type)) continue;
        if (operation.source_account && operation.source_account !== intent.solver) continue;
        const destination = String(operation.to ?? "");
        const network = this.config.get("stellar.network", { infer: true });
        let assetContractId: string;
        try {
          assetContractId = operation.asset_type === "native"
            ? Asset.native().contractId(NETWORK_PASSPHRASES[network])
            : new Asset(String(operation.asset_code ?? ""), String(operation.asset_issuer ?? ""))
                .contractId(NETWORK_PASSPHRASES[network]);
        } catch {
          continue;
        }
        if (destination !== intent.user) continue;
        // Horizon exposes classic assets by code/issuer. Soroban contract IDs
        // require Soroban RPC event verification, and are never credited here.
        if (assetContractId !== intent.dstToken.contract) continue;
        const raw = type.startsWith("path_payment_") ? operation.destination_amount : operation.amount;
        if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw)) continue;
        const delivered = decimalToBaseUnits(raw, intent.dstToken.decimals);
        if (BigInt(delivered) < BigInt(intent.minDstAmount)) {
          return { status: "rejected", reason: "insufficient_delivered_amount" };
        }
        return { status: "verified", deliveredAmount: delivered, operation: type };
      }
      return { status: "rejected", reason: "matching_payment_missing" };
    } catch {
      return { status: "pending", reason: "horizon_unavailable" };
    }
  }
}

function decimalToBaseUnits(value: string, decimals: number): string {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Horizon amount precision exceeds token decimals");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
