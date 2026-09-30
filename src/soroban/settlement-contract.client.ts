import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { StellarTxService, InvokeContractResult } from "./stellar-tx.service";

export interface RegisterIntentParams {
  intentId: string;
  user: string; // Stellar account address
  srcChain: string;
  srcToken: string; // EVM address or Stellar contract ID
  srcAmount: bigint;
  dstToken: string; // Stellar contract ID
  minDstAmount: bigint;
  deadline: number; // Unix timestamp (u64)
}

export interface AcceptIntentParams {
  intentId: string;
  solver: string; // Stellar account address
}

export interface SettleFillParams {
  intentId: string;
  solver: string;
  fillAmount: bigint;
  txHash: string;
}

export interface CancelIntentParams {
  intentId: string;
  user: string;
}

export interface MarkExpiredParams {
  intentId: string;
}

@Injectable()
export class SettlementContractClient {
  private readonly logger = new Logger(SettlementContractClient.name);

  constructor(
    private readonly stellarTxService: StellarTxService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  private get contractId(): string {
    return this.configService.get("stellar.settlementContractId", { infer: true }) ?? "";
  }

  async registerIntent(params: RegisterIntentParams): Promise<InvokeContractResult> {
    this.logger.log(`registerIntent intentId=${params.intentId}`);
    return this.stellarTxService.invokeContract({
      contractId: this.contractId,
      method: "register_intent",
      args: this.buildRegisterIntentArgs(params),
    });
  }

  async acceptIntent(params: AcceptIntentParams): Promise<InvokeContractResult> {
    this.logger.log(`acceptIntent intentId=${params.intentId} solver=${params.solver}`);
    return this.stellarTxService.invokeContract({
      contractId: this.contractId,
      method: "accept_intent",
      args: [
        nativeToScVal(params.intentId, { type: "string" }),
        new Address(params.solver).toScVal(),
      ],
    });
  }

  async settleFill(params: SettleFillParams): Promise<InvokeContractResult> {
    this.logger.log(`settleFill intentId=${params.intentId} solver=${params.solver}`);
    return this.stellarTxService.invokeContract({
      contractId: this.contractId,
      method: "settle_fill",
      args: [
        nativeToScVal(params.intentId, { type: "string" }),
        new Address(params.solver).toScVal(),
        nativeToScVal(params.fillAmount, { type: "i128" }),
        nativeToScVal(params.txHash, { type: "string" }),
      ],
    });
  }

  async cancelIntent(params: CancelIntentParams): Promise<InvokeContractResult> {
    this.logger.log(`cancelIntent intentId=${params.intentId}`);
    return this.stellarTxService.invokeContract({
      contractId: this.contractId,
      method: "cancel_intent",
      args: [
        nativeToScVal(params.intentId, { type: "string" }),
        new Address(params.user).toScVal(),
      ],
    });
  }

  async markExpired(params: MarkExpiredParams): Promise<InvokeContractResult> {
    this.logger.log(`markExpired intentId=${params.intentId}`);
    return this.stellarTxService.invokeContract({
      contractId: this.contractId,
      method: "mark_expired",
      args: [nativeToScVal(params.intentId, { type: "string" })],
    });
  }

  private buildRegisterIntentArgs(params: RegisterIntentParams): xdr.ScVal[] {
    return [
      nativeToScVal(params.intentId, { type: "string" }),
      new Address(params.user).toScVal(),
      nativeToScVal(params.srcChain, { type: "symbol" }),
      nativeToScVal(params.srcToken, { type: "string" }),
      nativeToScVal(params.srcAmount, { type: "i128" }),
      new Address(params.dstToken).toScVal(),
      nativeToScVal(params.minDstAmount, { type: "i128" }),
      nativeToScVal(params.deadline, { type: "u64" }),
    ];
  }
}
