import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { logger } from "../common/logger";
import { SignerService } from "./signer.service";

const NETWORK_PASSPHRASE: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

export interface SlashParams {
  solverAddress: string;
  intentId: string;
  reason: string;
}

export interface SlashResult {
  /** true only if a transaction was actually broadcast to the network. */
  submitted: boolean;
  /** true if we got far enough to run a (network, non-mutating) simulation. */
  simulated: boolean;
  txHash?: string;
  detail: string;
}

/**
 * Client for the on-chain solver-registry contract's penalty path.
 *
 * The service builds the contract call, simulates it, and when the dry-run flag
 * is disabled it signs and submits the transaction using the configured Soroban
 * signer. This preserves the "do not let a bad record explode the sweep cycle"
 * guarantee by returning structured SlashResult values on any failure instead of
 * throwing.
 */
@Injectable()
export class SolverRegistryService {
  private readonly contractId: string;
  private readonly signingKey: string;
  private readonly networkPassphrase: string;
  private readonly server: SorobanRpc.Server;
  private readonly dryRun: boolean;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly signerService?: SignerService,
  ) {
    this.contractId = configService.get("stellar.solverRegistryContractId", { infer: true });
    this.signingKey = configService.get("stellar.signingKey", { infer: true });
    const network = configService.get("stellar.network", { infer: true });
    this.networkPassphrase = NETWORK_PASSPHRASE[network];
    const rpcUrl = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.dryRun = Boolean(configService.get("onchainWritesDryRun", { infer: true }));
  }

  get isConfigured(): boolean {
    return this.contractId.length > 0 && this.signingKey.length > 0;
  }

  async slashSolver(params: SlashParams): Promise<SlashResult> {
    if (!this.isConfigured) {
      const detail =
        "SOLVER_REGISTRY_CONTRACT_ID or SOROBAN_SIGNING_KEY not configured — no-op";
      logger.info(
        `[solver-registry] would slash solver=${params.solverAddress} intent=${params.intentId} reason="${params.reason}" (${detail})`,
      );
      return { submitted: false, simulated: false, detail };
    }

    try {
      const sourceKeypair = this.signerService
        ? Keypair.fromSecret(this.signingKey)
        : Keypair.fromSecret(this.signingKey);
      const account = await this.server.getAccount(sourceKeypair.publicKey());
      const contract = new Contract(this.contractId);

      const operation = contract.call(
        "slash",
        Address.fromString(params.solverAddress).toScVal(),
        nativeToScVal(params.intentId, { type: "string" }),
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        const detail = `simulation failed: ${simulation.error}`;
        logger.error(
          `[solver-registry] slash simulation errored for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
        );
        return { submitted: false, simulated: true, detail };
      }

      if (this.dryRun) {
        const detail = "dry-run enabled — simulated only, transaction not submitted";
        logger.info(
          `[solver-registry] simulated slash tx for solver=${params.solverAddress} intent=${params.intentId} (${detail})`,
        );
        return { submitted: false, simulated: true, detail };
      }

      const signedTx = this.signerService ? this.signerService.sign(tx) : tx.sign(sourceKeypair);
      const response = await this.server.sendTransaction(signedTx);

      if (response.status === "PENDING" || response.status === "SUCCESS") {
        const txHash = response.hash || "unknown";
        const detail = `submitted via ${response.status}`;
        logger.info(
          `[solver-registry] submitted slash tx for solver=${params.solverAddress} intent=${params.intentId} txHash=${txHash} (${detail})`,
        );
        return { submitted: true, simulated: true, txHash, detail };
      }

      const detail = `submission failed: status=${response.status}`;
      logger.error(
        `[solver-registry] slash broadcast failed for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
      );
      return { submitted: false, simulated: true, detail };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(
        `[solver-registry] slash call errored for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
      );
      return { submitted: false, simulated: false, detail };
    }
  }
}
