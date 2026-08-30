import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";

export interface InvokeContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface InvokeContractResult {
  hash: string;
  status: string;
}

export class SorobanSimulationError extends Error {}
export class SorobanSubmissionError extends Error {}
export class SorobanPollingTimeoutError extends Error {}

@Injectable()
export class StellarTxService {
  private readonly networkPassphrase: string;
  private readonly maxPolls = 30;
  private readonly pollIntervalMs = 1000;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly sorobanService: SorobanService,
    private readonly signerService: SignerService,
  ) {
    const network = configService.get("stellar.network", { infer: true });
    this.networkPassphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  }

  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    return this.signerService.withNextSequence(async (account) => {
      const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
        .addOperation(
          Operation.invokeHostFunction({
            func: new Contract(params.contractId).call(params.method, ...params.args),
            auth: [],
          }),
        )
        .setTimeout(300)
        .build();

      const prepared = await this.prepareTransaction(transaction);
      const signed = this.signerService.sign(prepared);
      let submitted: any;
      try {
        submitted = await this.sorobanService.sendTransaction(signed);
      } catch (error) {
        throw new SorobanSubmissionError(`Soroban transaction submission failed: ${String(error)}`);
      }

      if (submitted.status === "ERROR") {
        throw new SorobanSubmissionError(submitted.errorResult ?? "Soroban transaction was rejected");
      }
      return this.waitForConfirmation(submitted.hash);
    });
  }

  private async prepareTransaction(transaction: Transaction): Promise<Transaction> {
    let simulation: any;
    try {
      simulation = await this.sorobanService.simulateTransaction(transaction);
    } catch (error) {
      throw new SorobanSimulationError(`Soroban simulation failed: ${String(error)}`);
    }
    if (!SorobanRpc.Api.isSimulationSuccess(simulation)) {
      throw new SorobanSimulationError(simulation.error ?? "Soroban simulation was rejected");
    }
    try {
      return SorobanRpc.assembleTransaction(transaction, simulation).build();
    } catch (error) {
      throw new SorobanSimulationError(`Soroban transaction preparation failed: ${String(error)}`);
    }
  }

  private async waitForConfirmation(hash: string): Promise<InvokeContractResult> {
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      const result: any = await this.sorobanService.getTransaction(hash);
      if (result.status === "SUCCESS") return { hash, status: result.status };
      if (result.status === "FAILED") {
        throw new SorobanSubmissionError(result.errorResult ?? "Soroban transaction failed");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new SorobanPollingTimeoutError(`Timed out waiting for Soroban transaction ${hash}`);
  }
}
