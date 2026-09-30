import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

const CACHE_TTL_MS = 30_000;
const NETWORK_PASSPHRASE: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

export interface OnChainSolverBond {
  bondAmount: bigint;
  isActive: boolean;
}

interface CacheEntry {
  value: OnChainSolverBond;
  expiresAt: number;
}

/** Read-only, short-lived view of a solver's authoritative registry state. */
@Injectable()
export class SolverBondService {
  private readonly logger = new Logger(SolverBondService.name);
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly server: SorobanRpc.Server;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: ConfigService<AppConfig, true>) {
    this.contractId = config.get("stellar.solverRegistryContractId", { infer: true });
    const network = config.get("stellar.network", { infer: true });
    this.networkPassphrase = NETWORK_PASSPHRASE[network];
    const rpcUrl = config.get("stellar.sorobanRpcUrl", { infer: true });
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  /**
   * Read the bond and active bit from the solver-registry contract using a
   * non-mutating Soroban simulation. RPC/configuration failures return 503;
   * cached successful reads live for at most 30 seconds.
   */
  async getBond(address: string): Promise<OnChainSolverBond> {
    const key = address.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (!this.contractId) {
      throw this.unavailable("Solver registry contract is not configured");
    }

    try {
      const account = await this.server.getAccount(address);
      const contract = new Contract(this.contractId);
      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call("get_bond", Address.fromString(address).toScVal()))
        .addOperation(contract.call("is_active", Address.fromString(address).toScVal()))
        .setTimeout(30)
        .build();
      const simulation = await this.server.simulateTransaction(transaction);
      if (SorobanRpc.Api.isSimulationError(simulation) || !simulation.results || simulation.results.length < 2) {
        throw new Error(SorobanRpc.Api.isSimulationError(simulation) ? simulation.error : "missing simulation results");
      }

      const bondNative = scValToNative(simulation.results[0].xdr);
      const activeNative = scValToNative(simulation.results[1].xdr);
      const bondAmount = this.parseBondAmount(bondNative);
      if (typeof activeNative !== "boolean") throw new Error("invalid active status returned by registry");

      const value = { bondAmount, isActive: activeNative };
      this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`On-chain solver-bond read failed for ${address}: ${detail}`);
      throw this.unavailable("Unable to verify solver bond with the registry contract");
    }
  }

  /** Invalidate a cached solver state when a registry event changes it. */
  invalidate(address: string): void {
    this.cache.delete(address.toLowerCase());
  }

  /** Invalidate every entry, e.g. after an unaddressed registry event. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private parseBondAmount(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    throw new Error("invalid bond amount returned by registry");
  }

  private unavailable(message: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "BOND_VERIFICATION_UNAVAILABLE",
      error: message,
      message,
    });
  }
}