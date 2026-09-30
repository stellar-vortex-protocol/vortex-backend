import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { SorobanService } from "./soroban.service";
import {
  AbiVersionByContract,
  CONTRACT_NAMES,
  CONTRACT_VERSION_REGISTRY,
  ContractName,
  SupportedContractVersions,
} from "./contracts/contract-versions";

/** Background poll cadence and the preflight staleness bound (issue #402). */
export const CONTRACT_VERSION_POLL_MS = 60_000;
export const CONTRACT_VERSION_MAX_AGE_MS = 60_000;

/** Placeholder hash for Stellar Asset Contracts, which have no WASM. */
export const STELLAR_ASSET_CONTRACT = "stellar-asset-contract";

export type ContractVersionStatus =
  /**
   * No contract ID configured — the on-chain path is off. Not read-only mode;
   * callers check configuration before writing (assertWritable still refuses).
   */
  | "unconfigured"
  /** Configured but not checked yet. */
  | "pending"
  /** WASM hash maps to a supported ABI — writes allowed. */
  | "supported"
  /** WASM hash is not in SUPPORTED_CONTRACT_VERSIONS — read-only. */
  | "unknown_hash"
  /** The instance could not be read (RPC error / not deployed) — read-only. */
  | "unreachable";

export interface ContractVersionState {
  contract: ContractName;
  contractId: string;
  status: ContractVersionStatus;
  /** Lower-case hex WASM hash of the deployed code. */
  wasmHash?: string;
  abiVersion?: string;
  /** ISO timestamp of the last successful or failed check. */
  checkedAt?: string;
  /** Hash seen before the most recent upgrade, if one was detected. */
  previousWasmHash?: string;
  upgradedAt?: string;
  error?: string;
}

export interface ContractVersionSnapshot {
  /** True when any configured contract is not on a supported version. */
  readOnly: boolean;
  contracts: Record<ContractName, ContractVersionState>;
}

/** Details of a contract upgrade event ingested from the chain. */
export interface ContractUpgradeEvent {
  contractId: string;
  ledger: number;
  txHash?: string;
  /** New WASM hash, when the event carries it. */
  wasmHash?: string;
}

/** 503 raised when a write targets a contract on an unsupported version. */
export class ContractVersionUnsupportedException extends ServiceUnavailableException {
  constructor(readonly state: ContractVersionState) {
    super({
      error: "Contract version not supported — backend is in read-only mode for this contract",
      contract: state.contract,
      contractId: state.contractId,
      status: state.status,
      wasmHash: state.wasmHash,
      detail: state.error,
    });
  }
}

/**
 * Tracks the deployed WASM hash of the settlement and solver-registry
 * contracts and gates writes on it (issue #402).
 *
 * - Polls each configured contract's instance every 60 s and maps the hash to
 *   an ABI version via SUPPORTED_CONTRACT_VERSIONS.
 * - {@link assertWritable} is the write preflight: it re-reads the hash when
 *   the cached one is older than 60 s, so an upgrade is detected before the
 *   next write, and throws a 503 for unknown or unreadable versions.
 * - A hash change is logged, counted (`vortex_contract_upgrades_total`) and
 *   appended to the `contract_upgrades` table; an unsupported version raises
 *   an alert log and sets `vortex_contract_version_supported{contract}` to 0.
 * - State is exposed in `GET /health` and `GET /api/v1/chain/network`.
 */
@Injectable()
export class ContractVersionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractVersionService.name);
  private readonly states = new Map<ContractName, ContractVersionState>();
  private readonly checkedAtMs = new Map<ContractName, number>();
  private readonly inFlight = new Map<ContractName, Promise<ContractVersionState>>();
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly soroban: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
    @Inject(CONTRACT_VERSION_REGISTRY) private readonly registry: SupportedContractVersions,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    for (const contract of CONTRACT_NAMES) {
      const contractId = this.contractIdFor(contract);
      this.states.set(contract, { contract, contractId, status: contractId ? "pending" : "unconfigured" });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.refreshAll();
    this.interval = setInterval(() => {
      this.refreshAll().catch((err) =>
        this.logger.error(`[contract-version] poll failed: ${(err as Error).message}`),
      );
    }, CONTRACT_VERSION_POLL_MS);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /** Current state of every tracked contract. */
  snapshot(): ContractVersionSnapshot {
    const contracts = Object.fromEntries(
      CONTRACT_NAMES.map((c) => [c, { ...this.states.get(c)! }]),
    ) as Record<ContractName, ContractVersionState>;
    const readOnly = Object.values(contracts).some(
      (s) => s.status !== "unconfigured" && s.status !== "supported",
    );
    return { readOnly, contracts };
  }

  /**
   * Write preflight. Returns the ABI version to encode with, re-checking the
   * WASM hash first when the cached value is older than
   * {@link CONTRACT_VERSION_MAX_AGE_MS}.
   *
   * @throws ContractVersionUnsupportedException when the contract is
   *   configured but its version is unknown, unreadable, or unchecked.
   */
  async assertWritable<C extends ContractName>(
    contract: C,
  ): Promise<{ abiVersion: AbiVersionByContract[C]; wasmHash: string }> {
    let state = this.states.get(contract)!;
    const age = Date.now() - (this.checkedAtMs.get(contract) ?? 0);
    if (state.status !== "unconfigured" && age > CONTRACT_VERSION_MAX_AGE_MS) {
      state = await this.refresh(contract);
    }
    if (state.status !== "supported" || !state.abiVersion || !state.wasmHash) {
      this.metrics?.recordContractWriteBlocked(contract);
      throw new ContractVersionUnsupportedException(state);
    }
    return { abiVersion: state.abiVersion as AbiVersionByContract[C], wasmHash: state.wasmHash };
  }

  async refreshAll(): Promise<void> {
    await Promise.all(CONTRACT_NAMES.map((c) => this.refresh(c)));
  }

  /** Re-read one contract's WASM hash. Concurrent callers share one RPC call. */
  refresh(contract: ContractName): Promise<ContractVersionState> {
    const pending = this.inFlight.get(contract);
    if (pending) return pending;
    const run = this.doRefresh(contract).finally(() => this.inFlight.delete(contract));
    this.inFlight.set(contract, run);
    return run;
  }

  /**
   * Handle an upgrade event emitted by a tracked contract: record it in the
   * upgrade history and re-check the hash immediately rather than waiting for
   * the next poll.
   */
  async recordUpgradeEvent(event: ContractUpgradeEvent): Promise<void> {
    const contract = CONTRACT_NAMES.find((c) => this.contractIdFor(c) === event.contractId);
    if (!contract) return;
    this.logger.warn(
      `[contract-version] upgrade event for ${contract} (${event.contractId}) at ledger=${event.ledger} tx=${event.txHash ?? "?"}`,
    );
    const before = this.states.get(contract)!;
    const after = await this.refresh(contract);
    // The poll path records hash changes itself; record the event only when
    // it did not (e.g. the event arrived after a poll already saw the hash).
    if (before.wasmHash === after.wasmHash || !before.wasmHash) {
      this.metrics?.recordContractUpgrade(contract, "event");
      this.persistUpgrade(contract, {
        previousWasmHash: before.wasmHash,
        wasmHash: event.wasmHash ?? after.wasmHash,
        abiVersion: after.abiVersion,
        source: "event",
        ledger: event.ledger,
        txHash: event.txHash,
      });
    }
  }

  private async doRefresh(contract: ContractName): Promise<ContractVersionState> {
    const contractId = this.contractIdFor(contract);
    const previous = this.states.get(contract)!;
    const checkedAt = new Date().toISOString();
    this.checkedAtMs.set(contract, Date.now());

    if (!contractId) {
      const state: ContractVersionState = { contract, contractId, status: "unconfigured", checkedAt };
      this.states.set(contract, state);
      return state;
    }

    let next: ContractVersionState;
    try {
      const wasmHash = await this.readWasmHash(contractId);
      const abiVersion = this.registry[contract][wasmHash];
      next = {
        contract,
        contractId,
        status: abiVersion ? "supported" : "unknown_hash",
        wasmHash,
        abiVersion,
        checkedAt,
        previousWasmHash: previous.previousWasmHash,
        upgradedAt: previous.upgradedAt,
      };
      if (previous.wasmHash && previous.wasmHash !== wasmHash) {
        next.previousWasmHash = previous.wasmHash;
        next.upgradedAt = checkedAt;
        this.logger.warn(
          `[contract-version] ${contract} (${contractId}) upgraded ${previous.wasmHash} → ${wasmHash} ` +
            `(abi=${abiVersion ?? "UNKNOWN"})`,
        );
        this.metrics?.recordContractUpgrade(contract, "poll");
        this.persistUpgrade(contract, {
          previousWasmHash: previous.wasmHash,
          wasmHash,
          abiVersion,
          source: "poll",
        });
      }
    } catch (err) {
      next = {
        ...previous,
        contract,
        contractId,
        status: "unreachable",
        checkedAt,
        error: (err as Error).message,
      };
    }

    this.states.set(contract, next);
    this.metrics?.setContractVersionSupported(contract, next.status === "supported");
    if (next.status !== "supported" && next.status !== previous.status) {
      // ALERT: surfaced as an error log (→ Sentry/log shipping) and the
      // vortex_contract_version_supported gauge; see contract-upgrades.md.
      this.logger.error(
        `[contract-version] ALERT ${contract} (${contractId}) is ${next.status}` +
          `${next.wasmHash ? ` wasmHash=${next.wasmHash}` : ""}${next.error ? ` error=${next.error}` : ""} ` +
          `— writes to this contract are disabled (read-only mode). See docs/runbooks/contract-upgrades.md`,
      );
    } else if (next.status === "supported" && previous.status !== "supported" && previous.status !== "pending") {
      this.logger.log(`[contract-version] ${contract} back on supported ABI ${next.abiVersion}; writes re-enabled`);
    }
    return next;
  }

  /** Read the WASM hash from the contract's instance ledger entry. */
  private async readWasmHash(contractId: string): Promise<string> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const { entries } = await this.soroban.getLedgerEntries(key);
    if (!entries?.length) throw new Error("contract instance not found on the network");

    const executable = entries[0].val.contractData().val().instance().executable();
    if (executable.switch().name === "contractExecutableStellarAsset") return STELLAR_ASSET_CONTRACT;
    return executable.wasmHash().toString("hex");
  }

  private contractIdFor(contract: ContractName): string {
    const key = contract === "settlement" ? "stellar.settlementContractId" : "stellar.solverRegistryContractId";
    return (this.configService.get(key, { infer: true }) as string | undefined) ?? "";
  }

  /** Fire-and-forget append to `contract_upgrades`; failures are logged, never thrown. */
  private persistUpgrade(
    contract: ContractName,
    record: {
      previousWasmHash?: string;
      wasmHash?: string;
      abiVersion?: string;
      source: "poll" | "event";
      ledger?: number;
      txHash?: string;
    },
  ): void {
    if (!this.prisma?.contractUpgrade) return;
    this.prisma.contractUpgrade
      .create({
        data: {
          contractName: contract,
          contractId: this.contractIdFor(contract),
          previousWasmHash: record.previousWasmHash ?? null,
          wasmHash: record.wasmHash ?? null,
          abiVersion: record.abiVersion ?? null,
          source: record.source,
          ledger: record.ledger ?? null,
          txHash: record.txHash ?? null,
        },
      })
      .catch((err: unknown) =>
        this.logger.error(`[contract-version] failed to record upgrade history: ${(err as Error).message}`),
      );
  }
}
