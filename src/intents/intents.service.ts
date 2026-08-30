import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, xdr } from "@stellar/stellar-sdk";
import { v4 as uuidv4 } from "uuid";
import { AppConfig } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

@Injectable()
export class IntentsService {
  private readonly intents = new Map<string, Intent>();

  constructor(
    @Optional() private readonly stellarTxService?: StellarTxService,
    @Optional() private readonly configService?: ConfigService<AppConfig, true>,
  ) {
    this.seed();
  }

  async create(data: Omit<Intent, "intentId" | "createdAt" | "state">): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000);
    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: data.deadline ?? now + 1800,
    };
    const enabled = process.env.ONCHAIN_INTENTS_ENABLED === "true";
    if (enabled) {
      const contractId = this.configService?.get("stellar.settlementContractId", { infer: true });
      if (!contractId || !this.stellarTxService) throw new Error("On-chain intent registration is not configured");
      await this.stellarTxService.invokeContract({
        contractId,
        method: "create_intent",
        args: this.buildCreateIntentArgs(intent),
      });
    }
    this.intents.set(intent.intentId, intent);
    return intent;
  }

  private buildCreateIntentArgs(intent: Intent): xdr.ScVal[] {
    return [
      xdr.ScVal.scvString(intent.intentId),
      xdr.ScVal.scvAddress(Address.fromString(intent.user).toScAddress()),
      xdr.ScVal.scvString(intent.srcChain),
      xdr.ScVal.scvString(intent.srcToken.address),
      xdr.ScVal.scvU128(xdr.UInt128.fromString(intent.srcAmount)),
      xdr.ScVal.scvAddress(Address.fromString(intent.dstToken.contract).toScAddress()),
      xdr.ScVal.scvU128(xdr.UInt128.fromString(intent.minDstAmount)),
      xdr.ScVal.scvU64(xdr.Uint64.fromString(String(intent.deadline))),
    ];
  }

  get(id: string): Intent | undefined {
    return this.intents.get(id);
  }

  getAll(): Intent[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getByState(state: IntentState): Intent[] {
    return this.getAll().filter((i) => i.state === state);
  }

  getByUser(user: string): Intent[] {
    return this.getAll().filter((i) => i.user.toLowerCase() === user.toLowerCase());
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.intents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.intents.set(id, updated);
    return updated;
  }

  reconcileFilled(id: string, fillAmount: string, txHash?: string): Intent | null {
    const existing = this.intents.get(id);
    if (!existing) return null;
    return this.update(id, {
      state: "filled",
      filledAt: Math.floor(Date.now() / 1000),
      fillAmount,
      txHash,
    });
  }

  private seed() {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.intents.set(intent.intentId, intent);
    }
  }
}
