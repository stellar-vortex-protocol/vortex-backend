import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Asset, SorobanRpc, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { EgressPurpose, HttpEgressService } from "../common/http-egress";
import { AppConfig, NETWORK_PASSPHRASES } from "../config/configuration";
import { Intent } from "../intents/intents.types";
import { SorobanService } from "./soroban.service";

/** Approximate Stellar ledger close interval, used to size the event lookback. */
const LEDGER_SECONDS = 5;
/** Longest per-chain fill window (CHAIN_FILL_WINDOW_DEFAULTS.ethereum) — a fill can't predate acceptance by more. */
const MAX_FILL_WINDOW_SECONDS = 1800;
const EVENTS_PAGE_LIMIT = 200;
const MAX_EVENT_PAGES = 10;

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

/** A fill observed on-chain, judged on chain time (ledger close). */
export interface LandedFill {
  txHash: string;
  ledger: number;
  /** Ledger close time, unix seconds — chain time, not server time. */
  closedAt: number;
}

/**
 * Independent verification of solver fills.
 *
 * Two views over the same question ("did this fill really land?"):
 *
 *  - {@link verify} checks Horizon's indexed classic payments against a
 *    persisted intent (memo, destination, asset contract, delivered amount).
 *  - {@link findLandedFill} / {@link verifyFillProof} (issue #397) answer from
 *    chain data alone for the slashing saga: settlement-contract events and
 *    transaction meta, timed on ledger close rather than server time.
 *
 * The chain-data methods throw on RPC failure: the caller must treat
 * "couldn't check" as "don't slash yet", never as "no fill".
 */
@Injectable()
export class FillVerifierService {
  private readonly logger = new Logger(FillVerifierService.name);
  private readonly egress: HttpEgressService;
  private readonly horizonBase: string;
  private readonly settlementContractId: string;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    /**
     * Soroban RPC handle for the chain-data methods. Injected `@Optional()`
     * so Horizon-only graphs (and the unit harnesses that construct this
     * service directly) keep working; the chain methods fail loudly rather
     * than silently answering "no fill" when it is absent.
     */
    @Optional() private readonly sorobanService?: SorobanService,
  ) {
    const horizonUrl = config.get("stellar.horizonUrl", { infer: true });
    this.horizonBase = horizonUrl.replace(/\/$/, "");
    this.egress = new HttpEgressService({
      timeoutMs: 10_000,
      maxRedirects: 0,
      maxBodySizeBytes: 1_048_576,
      allowlist: [new URL(horizonUrl).hostname],
      blockPrivateRanges: false,
    });
    this.settlementContractId = config.get("stellar.settlementContractId", { infer: true });
  }

  /**
   * Verify the transaction against the persisted intent. Unknown/indexing errors
   * remain retryable; malformed or mismatched transactions are definitive.
   */
  async verify(txHash: string, intent: Intent): Promise<FillVerificationVerdict> {
    const base = this.horizonBase;
    let transaction: HorizonTransaction;
    try {
      const response = await this.egress.fetch(`${base}/transactions/${encodeURIComponent(txHash)}`, {
        purpose: EgressPurpose.HORIZON,
      });
      if (response.statusCode === 404) return { status: "pending", reason: "not_indexed" };
      if (response.statusCode < 200 || response.statusCode >= 300) return { status: "pending", reason: "horizon_unavailable" };
      transaction = JSON.parse(response.body) as HorizonTransaction;
    } catch {
      return { status: "pending", reason: "horizon_unavailable" };
    }

    if (transaction.successful !== true) return { status: "rejected", reason: "transaction_failed" };
    if (transaction.memo_type !== "text" || transaction.memo !== intent.intentId) {
      return { status: "rejected", reason: "intent_memo_mismatch" };
    }
    if (!transaction._links?.operations?.href) return { status: "rejected", reason: "operations_missing" };
    try {
      const response = await this.egress.fetch(`${base}/transactions/${encodeURIComponent(txHash)}/operations?limit=200&order=asc`, {
        purpose: EgressPurpose.HORIZON,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) return { status: "pending", reason: "horizon_unavailable" };
      const body = JSON.parse(response.body) as { _embedded?: { records?: Array<Record<string, unknown>> } };
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

  // ── Chain-data verification for the slashing saga (issue #397) ────────────

  /**
   * Scans the settlement contract's recent events for an `intent_filled`
   * event for `intentId` that closed by `latestAcceptable`.
   *
   * Returns null when none is found — including when SETTLEMENT_CONTRACT_ID is
   * unset, since there is then no on-chain fill path to verify against.
   */
  async findLandedFill(
    intentId: string,
    fillDeadline: number,
    latestAcceptable: number,
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<LandedFill | null> {
    if (!this.settlementContractId) return null;
    const soroban = this.requireSoroban();

    const latest = await soroban.getLatestLedger();
    const lookbackSeconds = Math.max(0, now - fillDeadline) + MAX_FILL_WINDOW_SECONDS;
    const startLedger = Math.max(1, latest.sequence - Math.ceil(lookbackSeconds / LEDGER_SECONDS));

    let cursor: string | undefined;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const response = await soroban.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [{ type: "contract", contractIds: [this.settlementContractId] }],
        limit: EVENTS_PAGE_LIMIT,
      });

      for (const event of response.events) {
        if (!isIntentFilled(event.topic, intentId)) continue;
        const closedAt = Math.floor(Date.parse(event.ledgerClosedAt) / 1000);
        if (closedAt <= latestAcceptable) {
          return { txHash: event.txHash, ledger: event.ledger, closedAt };
        }
        this.logger.log(
          `[fill-verifier] intent=${intentId} fill ${event.txHash} closed at ${closedAt}, ` +
            `after the acceptable bound ${latestAcceptable} — does not cancel the slash`,
        );
      }

      if (response.events.length < EVENTS_PAGE_LIMIT) break;
      cursor = response.events[response.events.length - 1].pagingToken;
    }
    return null;
  }

  /**
   * Verifies a solver-supplied fill proof: `txHash` must be a successful
   * transaction, closed by `latestAcceptable`, that emitted `intent_filled`
   * for `intentId` (from the settlement contract, when configured).
   */
  async verifyFillProof(
    txHash: string,
    intentId: string,
    latestAcceptable: number,
  ): Promise<{ valid: true; fill: LandedFill } | { valid: false; reason: string }> {
    const soroban = this.requireSoroban();
    const tx = await soroban.getTransaction(txHash);
    if (tx.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { valid: false, reason: `transaction status is ${tx.status}` };
    }
    if (tx.createdAt > latestAcceptable) {
      return {
        valid: false,
        reason: `fill closed at ${tx.createdAt}, after the acceptable bound ${latestAcceptable}`,
      };
    }
    if (!this.emitsIntentFilled(tx.resultMetaXdr, intentId)) {
      return { valid: false, reason: "transaction did not emit intent_filled for this intent" };
    }
    return { valid: true, fill: { txHash, ledger: tx.ledger, closedAt: tx.createdAt } };
  }

  /** The RPC handle, or a loud failure — absence must never read as "no fill". */
  private requireSoroban(): SorobanService {
    if (!this.sorobanService) {
      throw new Error(
        "FillVerifierService: SorobanService is not wired; chain-data verification unavailable",
      );
    }
    return this.sorobanService;
  }

  private emitsIntentFilled(meta: xdr.TransactionMeta, intentId: string): boolean {
    let events: xdr.ContractEvent[] = [];
    try {
      events = meta.v3().sorobanMeta()?.events() ?? [];
    } catch {
      return false;
    }
    return events.some((event) => {
      if (this.settlementContractId) {
        const contractId = event.contractId();
        if (!contractId || !this.matchesSettlementContract(contractId)) return false;
      }
      try {
        return isIntentFilled(event.body().v0().topics(), intentId);
      } catch {
        return false;
      }
    });
  }

  private matchesSettlementContract(contractId: Buffer): boolean {
    return StrKey.encodeContract(contractId) === this.settlementContractId;
  }
}

/** Topic layout shared with EventIngestionService: [event name, intentId, ...]. */
function isIntentFilled(topic: xdr.ScVal[], intentId: string): boolean {
  const decoded = topic.slice(0, 2).map((scVal) => {
    try {
      return scValToNative(scVal);
    } catch {
      return undefined;
    }
  });
  return decoded[0] === "intent_filled" && decoded[1] === intentId;
}

function decimalToBaseUnits(value: string, decimals: number): string {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Horizon amount precision exceeds token decimals");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
