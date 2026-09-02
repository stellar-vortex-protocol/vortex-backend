import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BASE_FEE,
  FeeBumpTransaction,
  nativeToScVal,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig, FeePercentile } from "../config/configuration";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";

export interface FeeEstimate {
  /** Classic inclusion fee, in stroops. */
  baseFee: string;
  /** Soroban resource fee returned by simulation, in stroops. */
  resourceFee: string;
  /** baseFee + resourceFee, in stroops. */
  totalFee: string;
}

export interface InvokeContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface InvokeContractResult {
  hash: string;
  status: string;
}

@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);
  private readonly feePercentile: FeePercentile;

  constructor(
    private readonly sorobanService: SorobanService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.feePercentile = configService.get("stellar.feePercentile", { infer: true });
  }

  /**
   * Recommended classic inclusion fee based on recent network activity.
   * Falls back to the network's minimum base fee if fee stats are unavailable
   * or the reported fee is degenerate (e.g. an idle network reporting "0").
   */
  async estimateBaseFee(): Promise<string> {
    try {
      const stats = await this.sorobanService.getFeeStats();
      const fee = stats.sorobanInclusionFee[this.feePercentile];
      return fee && fee !== "0" ? fee : BASE_FEE;
    } catch (err) {
      // Issue #300 — keep the log message operational but avoid leaking raw keys.
      // SDK errors can include XDR/transaction detail, so we only include the
      // sanitized error summary here rather than serializing the whole object.
      this.logger.warn(
        `Failed to fetch Soroban fee stats, falling back to base fee ${BASE_FEE}: ${(err as Error).message}`,
      );
      return BASE_FEE;
    }
  }

  /**
   * Estimates the total fee (base + resource) required to submit `transaction`
   * by simulating it against the network, instead of hardcoding a fee value.
   */
  async estimateFee(transaction: Transaction): Promise<FeeEstimate> {
    const baseFee = await this.estimateBaseFee();
    const simulation = await this.sorobanService.simulateTransaction(
      this.withFee(transaction, baseFee),
    );

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Fee estimation failed: transaction simulation error: ${simulation.error}`,
      );
    }

    const resourceFee = (simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .minResourceFee;
    const totalFee = (BigInt(baseFee) + BigInt(resourceFee)).toString();

    return { baseFee, resourceFee, totalFee };
  }

  /**
   * Simulates `transaction` and returns it assembled with the estimated
   * base + resource fee and Soroban transaction data, ready to sign.
   */
  async prepareTransaction(transaction: Transaction): Promise<Transaction> {
    const baseFee = await this.estimateBaseFee();
    const prepared = await this.sorobanService.prepareTransaction(
      this.withFee(transaction, baseFee),
    );

    this.logger.log(
      `Prepared transaction with fee ${prepared.fee} stroops (base fee ${baseFee})`,
    );

    return prepared as Transaction;
  }

  /**
   * Invokes a Soroban contract method.
   * Used by IntentsService when ONCHAIN_INTENTS_ENABLED is true.
   * This is a stub that will be expanded once the on-chain settlement
   * contract interface is finalised (see docs/architecture/onchain-settlement.md).
   */
  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    this.logger.log(
      `invokeContract contractId=${params.contractId} method=${params.method}`,
    );

    // TODO: Build, simulate, sign, and submit the actual Soroban transaction
    // once SignerService is wired here and the contract bindings are finalised.
    // For now, throw a clear error so callers know this isn't implemented yet.
    throw new Error(
      `invokeContract not yet implemented for method=${params.method} on contract=${params.contractId}`,
    );
  }

  private withFee(transaction: Transaction | FeeBumpTransaction, fee: string): Transaction {
    if ("innerTransaction" in transaction) {
      throw new TypeError("fee bump transactions are not supported");
    }

    return TransactionBuilder.cloneFrom(transaction, {
      fee,
      networkPassphrase: transaction.networkPassphrase,
    }).build();
  }
}
