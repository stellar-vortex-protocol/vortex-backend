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
import { PrismaService } from "../prisma/prisma.service";

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
    private readonly prisma: PrismaService,
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

    // Resolve the inner transaction up front so we can correlate the audit
    // record to the owning outbox entry via the inner-tx hash (the fee-bump
    // XDR itself is only known after buildFeeBump returns).
    let innerTx: Transaction | null = null;
    try {
      innerTx = new Transaction(opts.innerTxXdr, opts.networkPassphrase);
    } catch {
      // XDR might already be a fee-bump — unwrap it
      try {
        const feeBump = new FeeBumpTransaction(opts.innerTxXdr, opts.networkPassphrase);
        innerTx = feeBump.innerTransaction;
      } catch {
        innerTx = null;
      }
    }
    const txHashOrEnvelopeHash = innerTx ? innerTx.hash().toString("hex") : null;

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
      this.persistDecision({
        txHashOrEnvelopeHash,
        feeBumpCount: opts.feeBumpCount,
        percentileUsed: percentile,
        newFeeStroops: newFeePerOp,
        ceilingHit: true,
      });
      return null;
    }

    if (!innerTx) {
      // Could not decode the inner transaction; nothing to bump.
      this.persistDecision({
        txHashOrEnvelopeHash,
        feeBumpCount: opts.feeBumpCount,
        percentileUsed: percentile,
        newFeeStroops: newFeePerOp,
        ceilingHit: false,
      });
      throw new Error("Unable to decode inner transaction XDR for fee-bump");
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

    this.persistDecision({
      txHashOrEnvelopeHash,
      feeBumpCount: opts.feeBumpCount,
      percentileUsed: percentile,
      newFeeStroops: newFeePerOp,
      ceilingHit: false,
    });

    return {
      feeBumpXdr: feeBump.toXDR(),
      newFeeStroops: newFeePerOp,
      percentileUsed: percentile,
    };
  }

  /**
   * Fire-and-forget audit write. Mirrors ContractVersionService.persistUpgrade:
   * a failed audit write must never block fee-bump submission.
   */
  private persistDecision(record: {
    txHashOrEnvelopeHash: string | null;
    feeBumpCount: number;
    percentileUsed: FeePercentile;
    newFeeStroops: string;
    ceilingHit: boolean;
  }): void {
    if (!record.txHashOrEnvelopeHash) return;
    void this.prisma.feeBumpDecision
      .create({
        data: {
          txHashOrEnvelopeHash: record.txHashOrEnvelopeHash,
          feeBumpCount: record.feeBumpCount,
          percentileUsed: record.percentileUsed,
          newFeeStroops: record.newFeeStroops,
          ceilingHit: record.ceilingHit,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to persist fee-bump decision audit record: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
