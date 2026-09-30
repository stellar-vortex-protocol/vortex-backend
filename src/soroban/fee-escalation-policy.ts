import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { AppConfig, FeePercentile } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";

export interface FeeBumpResult {
  feeBumpXdr: string;
  newFeeStroops: string;
  percentileUsed: FeePercentile;
}

// Escalation ladder: each step is tried in order until the tx is included
// or the ceiling is hit.
const ESCALATION_LADDER: FeePercentile[] = ["p50", "p90", "p99"];

@Injectable()
export class FeeEscalationPolicy {
  private readonly logger = new Logger(FeeEscalationPolicy.name);
  private readonly maxFeeStroops: number;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly metricsService: MetricsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.maxFeeStroops = configService.get("stellar.maxFeeStroops", { infer: true });
  }

  /**
   * Returns true when the transaction should be fee-bumped.
   * Triggers on INSUFFICIENT_FEE result or when the tx is approaching its
   * time bound without inclusion.
   */
  shouldEscalate(opts: {
    errorResultCode?: string;
    feeBumpCount: number;
    maxTrackUntil: number;
    currentFeeStroops: string;
  }): boolean {
    if (opts.feeBumpCount >= ESCALATION_LADDER.length) return false;
    if (opts.errorResultCode === "tx_insufficient_fee") return true;
    // Escalate if within 60 s of expiry and not yet at max bumps
    const secsLeft = opts.maxTrackUntil - Math.floor(Date.now() / 1000);
    if (secsLeft <= 60 && secsLeft > 0) return true;
    return false;
  }

  /**
   * Builds a fee-bump envelope for the given inner-transaction XDR.
   * Returns null if the ceiling would be exceeded.
   *
   * Only the classic inclusion fee is bumped — Soroban resource fees are set
   * at simulation time and cannot be changed via fee-bump.
   */
  async buildFeeBump(opts: {
    innerTxXdr: string;
    feeSourceKeypair: Keypair;
    networkPassphrase: string;
    feeBumpCount: number;
  }): Promise<FeeBumpResult | null> {
    const step = Math.min(opts.feeBumpCount, ESCALATION_LADDER.length - 1);
    const percentile = ESCALATION_LADDER[step];

    let newFeePerOp: string;
    try {
      const stats = await this.sorobanService.getFeeStats();
      const raw = stats.sorobanInclusionFee[percentile];
      newFeePerOp = raw && raw !== "0" ? raw : BASE_FEE;
    } catch {
      newFeePerOp = BASE_FEE;
    }

    if (parseInt(newFeePerOp, 10) > this.maxFeeStroops) {
      this.logger.warn(
        `Fee-bump ceiling hit: requested ${newFeePerOp} stroops > max ${this.maxFeeStroops} stroops. Refusing to bump.`,
      );
      this.metricsService.txFeeBumpCeilingHits.inc();
      return null;
    }

    // Rebuild the inner transaction from XDR
    let innerTx: Transaction;
    try {
      innerTx = new Transaction(opts.innerTxXdr, opts.networkPassphrase);
    } catch {
      // XDR might already be a fee-bump — unwrap it
      const feeBump = new FeeBumpTransaction(opts.innerTxXdr, opts.networkPassphrase);
      innerTx = feeBump.innerTransaction;
    }

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      opts.feeSourceKeypair,
      newFeePerOp,
      innerTx,
      opts.networkPassphrase,
    );
    feeBump.sign(opts.feeSourceKeypair);

    this.metricsService.txFeeBumpTotal.inc({ percentile });
    this.logger.log(
      `Built fee-bump at ${percentile} (${newFeePerOp} stroops), bump #${opts.feeBumpCount + 1}`,
    );

    return {
      feeBumpXdr: feeBump.toXDR(),
      newFeeStroops: newFeePerOp,
      percentileUsed: percentile,
    };
  }
}
