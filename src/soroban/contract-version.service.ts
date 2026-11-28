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
    await this.loadPersistedRegistry();
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

  /**
   * Merge runtime-registered hashes from the `contract_version_registry`
   * table into the in-memory registry (issue #662). The static
   * SUPPORTED_CONTRACT_VERSIONS map stays as the seed/default, so existing
   * deployments keep working unmodified.
   */
  async loadPersistedRegistry(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.contractVersionRegistry.findMany({
        where: { retiredAt: null },
      });
      for (const row of rows) {
        const contract = row.contract as ContractName;
        if (!CONTRACT_NAMES.includes(contract)) continue;
        const bucket = (this.registry[contract] ??= {} as Record<string, string>);
        bucket[row.wasmHash] = row.abiVersion;
      }
    } catch (err) {
      this.logger.error(
        `[contract-version] failed to load persisted registry: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Register a runtime-supported WASM hash and immediately re-check the
   * contract so a currently-blocked contract becomes writable without waiting
   * for the next poll (issue #662).
   */
  async registerVersion<C extends ContractName>(
    contract: C,
    wasmHash: string,
    abiVersion: AbiVersionByContract[C],
  ): Promise<ContractVersionState> {
    const bucket = (this.registry[contract] ??= {} as Record<string, string>);
    bucket[wasmHash] = abiVersion;
    return this.refresh(contract);
  }

  /** Retire a runtime-registered WASM hash and re-check the contract. */
  async retireVersion(contract: ContractName, wasmHash: string): Promise<ContractVersionState> {
    const bucket = this.registry[contract] as Record<string, string> | undefined;
    if (bucket) delete bucket[wasmHash];
    return this.refresh(contract);
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
        previousWasmHash: before.wasm

/* … truncated 4892 chars — edit only what you need near the top … */
