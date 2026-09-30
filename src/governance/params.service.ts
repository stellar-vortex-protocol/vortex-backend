import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { AppConfig, CHAIN_DEADLINE_DEFAULTS, CHAIN_FILL_WINDOW_DEFAULTS, DEFAULT_DEADLINE_SECONDS, DEFAULT_FILL_WINDOW_SECONDS } from "../config/configuration";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-chain fill/deadline windows as sourced from on-chain governance. */
export interface ChainWindows {
  deadlineSeconds: number;
  fillWindowSeconds: number;
}

/** Validation bounds enforced backend-side even if governance passes insane values. */
export interface ParamBounds {
  /** Protocol fee in basis points [0, 10_000]. */
  feeBpsMin: number;
  feeBpsMax: number;
  /** Deadline in seconds [60, 86_400]. */
  deadlineSecondsMin: number;
  deadlineSecondsMax: number;
  /** Fill window in seconds [30, 43_200]. */
  fillWindowSecondsMin: number;
  fillWindowSecondsMax: number;
  /** Max exposure ratio as a fraction [0, 1]. */
  exposureRatioMin: number;
  exposureRatioMax: number;
  /** Slash amount in dst-token base units (string to avoid bigint serialisation issues). */
  slashAmountMin: string;
  slashAmountMax: string;
}

/** A full snapshot of all governance-sourced protocol parameters. */
export interface ProtocolParams {
  /** Monotonically increasing version counter — incremented each time the active params change. */
  version: number;
  /** Protocol fee in basis points (e.g. 30 = 0.30%). */
  feeBps: number;
  /** Per-chain deadline / fill-window overrides. Chains absent from this map use code defaults. */
  chains: Record<string, ChainWindows>;
  /** Maximum on-chain exposure ratio across all chains (0–1). */
  maxExposureRatio: number;
  /** Slash amount in dst-token base units. */
  slashAmount: string;
  /** Ledger sequence at which these params became active (or 0 for code defaults). */
  activeSinceLedger: number;
  /** ISO-8601 wall-clock timestamp when this version was adopted by the backend. */
  adoptedAt: string;
}

/** A governance change that is scheduled but not yet activated. */
export interface PendingChange {
  /** The parameter values that will take effect once `executionLedger` is reached. */
  params: ProtocolParams;
  /** Soroban ledger sequence at which the timelock unlocks. */
  executionLedger: number;
  /** Best-effort ISO-8601 ETA for `executionLedger` (computed from avg ledger time). */
  estimatedEta: string;
  /** ISO-8601 timestamp when this pending change was first observed by the backend. */
  observedAt: string;
}

/** Snapshot stored with each intent at creation time. */
export interface ParamsSnapshot {
  version: number;
  feeBps: number;
  deadlineSeconds: number;
  fillWindowSeconds: number;
  capturedAt: string;
}

/** Payload returned by GET /api/v1/params. */
export interface ParamsApiResponse {
  current: ProtocolParams;
  pending: PendingChange | null;
  history: ProtocolParams[];
}

// ---------------------------------------------------------------------------
// Hard validation bounds (backend enforces these even if governance passes insane values)
// ---------------------------------------------------------------------------

export const PARAM_BOUNDS: ParamBounds = {
  feeBpsMin: 0,
  feeBpsMax: 1_000,           // 10% max fee
  deadlineSecondsMin: 60,
  deadlineSecondsMax: 86_400, // 24 hours
  fillWindowSecondsMin: 30,
  fillWindowSecondsMax: 43_200, // 12 hours
  exposureRatioMin: 0,
  exposureRatioMax: 1,
  slashAmountMin: "0",
  slashAmountMax: "1000000000000", // 1e12 base units
};

/** How many historical snapshots to retain in memory. */
const MAX_HISTORY = 50;

/** Default fee in basis points when no on-chain contract is configured. */
const DEFAULT_FEE_BPS = 30;

/** Default max exposure ratio. */
const DEFAULT_MAX_EXPOSURE_RATIO = 0.05;

/** Default slash amount (in dst base units). */
const DEFAULT_SLASH_AMOUNT = "100000000";

/** Approximate Stellar ledger time in seconds (5 s per ledger). */
const STELLAR_LEDGER_TIME_SECONDS = 5;

// ---------------------------------------------------------------------------
// ProtocolParamsService
// ---------------------------------------------------------------------------

/**
 * Reads current + scheduled protocol parameters from the on-chain governance
 * contract and exposes them to the rest of the application.
 *
 * **Lifecycle**
 * - On module init, loads parameters immediately and starts a polling loop.
 * - On RPC failure, keeps the last-known values; *never* silently reverts to
 *   code defaults once a live value has been loaded.
 * - Each set of parameters is stamped with a monotonically increasing version
 *   counter so callers can detect when a refresh happened.
 *
 * **Validation**
 * - Values returned from the contract are validated against `PARAM_BOUNDS`
 *   before being adopted.  Out-of-bounds values are rejected with a loud error
 *   log; the previous good params remain active.
 *
 * @see ParamsSnapshot — stored on each intent at creation time
 * @see GET /api/v1/params — public endpoint backed by this service
 */
@Injectable()
export class ProtocolParamsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProtocolParamsService.name);

  private current: ProtocolParams;
  private pending: PendingChange | null = null;
  private readonly history: ProtocolParams[] = [];
  private pollTimer?: NodeJS.Timeout;
  private rpcServer?: SorobanRpc.Server;
  private versionCounter = 0;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
  ) {
    // Initialise with code defaults so the service is ready before the first
    // successful RPC poll.
    this.current = this.buildCodeDefaults();
  }

  // --------------------------------------------------------------------------
  // Lifecycle hooks
  // --------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    const contractId = this.configService.get("governance.paramsContractId", { infer: true });
    const rpcUrl = this.configService.get("stellar.sorobanRpcUrl", { infer: true });
    const pollMs = this.configService.get("governance.paramsPollIntervalMs", { infer: true });

    if (contractId) {
      this.rpcServer = new SorobanRpc.Server(rpcUrl, {
        allowHttp: rpcUrl.startsWith("http://"),
      });
      this.logger.log(
        `[params] Governance params contract: ${contractId} (poll every ${pollMs}ms)`,
      );
      await this.refresh();
    } else {
      this.logger.warn(
        "[params] PARAMS_CONTRACT_ID not set — using code defaults. " +
          "Set PARAMS_CONTRACT_ID to enable on-chain governance parameters.",
      );
    }

    this.pollTimer = setInterval(() => {
      this.refresh().catch((err: unknown) => {
        this.logger.error(
          `[params] Background refresh failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
      });
    }, pollMs ?? 30_000);
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Current active protocol parameters. */
  getCurrent(): ProtocolParams {
    return this.current;
  }

  /** Pending governance change, or null if none. */
  getPending(): PendingChange | null {
    return this.pending;
  }

  /** Historical parameter versions, newest-first, capped at MAX_HISTORY. */
  getHistory(): ProtocolParams[] {
    return [...this.history].reverse();
  }

  /**
   * Build a lightweight snapshot for attaching to a newly-created intent.
   * Uses the srcChain to pick the correct per-chain windows.
   */
  snapshotForChain(srcChain: string): ParamsSnapshot {
    const p = this.current;
    const chain = p.chains[srcChain];
    return {
      version: p.version,
      feeBps: p.feeBps,
      deadlineSeconds: chain?.deadlineSeconds ?? CHAIN_DEADLINE_DEFAULTS[srcChain] ?? DEFAULT_DEADLINE_SECONDS,
      fillWindowSeconds: chain?.fillWindowSeconds ?? CHAIN_FILL_WINDOW_DEFAULTS[srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS,
      capturedAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Internal: refresh from chain
  // --------------------------------------------------------------------------

  /**
   * Poll the governance contract and update current/pending params.
   * On error, logs and returns without modifying state.
   */
  async refresh(): Promise<void> {
    const contractId = this.configService.get("governance.paramsContractId", { infer: true });
    if (!contractId || !this.rpcServer) {
      // No contract configured — stay on code/env defaults (already in this.current).
      return;
    }

    try {
      const raw = await this.fetchContractState(contractId);
      await this.applyContractState(raw);
    } catch (err) {
      this.logger.error(
        `[params] Failed to read governance contract ${contractId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      this.logger.warn("[params] Retaining last-known parameters — will retry on next poll.");
    }
  }

  /**
   * Fetch the raw governance-contract ledger entries from Soroban RPC.
   * Returns a map of key → native JS value.
   */
  private async fetchContractState(contractId: string): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();

    // Keys we expect the parameters contract to expose. These are the symbolic
    // Soroban storage keys the contract is expected to publish under.
    const paramKeys = [
      "fee_bps",
      "max_exposure_ratio",
      "slash_amount",
      "deadline_stellar",
      "deadline_ethereum",
      "deadline_base",
      "deadline_polygon",
      "deadline_arbitrum",
      "deadline_optimism",
      "deadline_avalanche",
      "fill_window_stellar",
      "fill_window_ethereum",
      "fill_window_base",
      "fill_window_polygon",
      "fill_window_arbitrum",
      "fill_window_optimism",
      "fill_window_avalanche",
      "pending_fee_bps",
      "pending_max_exposure_ratio",
      "pending_slash_amount",
      "pending_execution_ledger",
    ];

    // Build xdr LedgerKey entries for each symbolic key
    const ledgerKeys = paramKeys.map((key) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(
              Buffer.from(contractId.slice(0, 32).padEnd(32, "\0")),
            ),
          ),
          key: xdr.ScVal.scvSymbol(key),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ),
    );

    const response = await this.rpcServer!.getLedgerEntries(...ledgerKeys);
    for (const entry of response.entries ?? []) {
      const ledgerEntry = entry.val;
      if (ledgerEntry.switch() !== xdr.LedgerEntryType.contractData()) continue;
      const data = ledgerEntry.contractData();
      const keyNative = scValToNative(data.key());
      const valNative = scValToNative(data.val());
      result.set(String(keyNative), valNative);
    }

    return result;
  }

  /**
   * Validate and apply the raw contract state map to `this.current` and
   * `this.pending`. Throws (or logs+skips) if values are out-of-bounds.
   */
  private async applyContractState(raw: Map<string, unknown>): Promise<void> {
    // ── Current params ─────────────────────────────────────────────────────

    const feeBps = this.parseAndClamp(
      raw,
      "fee_bps",
      PARAM_BOUNDS.feeBpsMin,
      PARAM_BOUNDS.feeBpsMax,
      DEFAULT_FEE_BPS,
      "feeBps",
    );

    const maxExposureRatio = this.parseAndClamp(
      raw,
      "max_exposure_ratio",
      PARAM_BOUNDS.exposureRatioMin,
      PARAM_BOUNDS.exposureRatioMax,
      DEFAULT_MAX_EXPOSURE_RATIO,
      "maxExposureRatio",
      true, // float
    );

    const slashAmountRaw = raw.get("slash_amount");
    const slashAmount = this.validateSlashAmount(
      slashAmountRaw !== undefined ? String(slashAmountRaw) : DEFAULT_SLASH_AMOUNT,
    );

    const chains = this.buildChainWindows(raw, "");

    // Get the latest ledger to record activeSinceLedger
    let currentLedger = 0;
    try {
      const ledger = await this.rpcServer!.getLatestLedger();
      currentLedger = ledger.sequence;
    } catch {
      // Non-fatal — activeSinceLedger remains 0 if RPC can't tell us
    }

    const candidate: ProtocolParams = {
      version: this.versionCounter + 1,
      feeBps,
      chains,
      maxExposureRatio,
      slashAmount,
      activeSinceLedger: currentLedger,
      adoptedAt: new Date().toISOString(),
    };

    // Only bump version + history if something actually changed
    if (this.hasChanged(this.current, candidate)) {
      this.history.push(this.current);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.versionCounter++;
      candidate.version = this.versionCounter;
      this.current = candidate;
      this.logger.log(
        `[params] Adopted new parameters v${this.versionCounter} ` +
          `(feeBps=${feeBps}, ledger=${currentLedger})`,
      );
    }

    // ── Pending change ──────────────────────────────────────────────────────

    const pendingExecutionLedger = raw.has("pending_execution_ledger")
      ? Number(raw.get("pending_execution_ledger"))
      : 0;

    if (pendingExecutionLedger > currentLedger && raw.has("pending_fee_bps")) {
      const pendingFeeBps = this.parseAndClamp(
        raw,
        "pending_fee_bps",
        PARAM_BOUNDS.feeBpsMin,
        PARAM_BOUNDS.feeBpsMax,
        feeBps,
        "pending.feeBps",
      );

      const pendingMaxExposureRatio = this.parseAndClamp(
        raw,
        "pending_max_exposure_ratio",
        PARAM_BOUNDS.exposureRatioMin,
        PARAM_BOUNDS.exposureRatioMax,
        maxExposureRatio,
        "pending.maxExposureRatio",
        true,
      );

      const pendingSlashAmountRaw = raw.get("pending_slash_amount");
      const pendingSlashAmount = this.validateSlashAmount(
        pendingSlashAmountRaw !== undefined ? String(pendingSlashAmountRaw) : slashAmount,
      );

      const ledgersUntilExec = pendingExecutionLedger - currentLedger;
      const secondsUntilExec = ledgersUntilExec * STELLAR_LEDGER_TIME_SECONDS;
      const etaDate = new Date(Date.now() + secondsUntilExec * 1_000);

      const pendingParams: ProtocolParams = {
        version: this.versionCounter + 1,
        feeBps: pendingFeeBps,
        chains: this.buildChainWindows(raw, "pending_"),
        maxExposureRatio: pendingMaxExposureRatio,
        slashAmount: pendingSlashAmount,
        activeSinceLedger: pendingExecutionLedger,
        adoptedAt: etaDate.toISOString(),
      };

      const alreadyObservedAt = this.pending?.observedAt ?? new Date().toISOString();
      this.pending = {
        params: pendingParams,
        executionLedger: pendingExecutionLedger,
        estimatedEta: etaDate.toISOString(),
        observedAt: alreadyObservedAt,
      };
    } else {
      // No pending change (or execution ledger already passed)
      this.pending = null;
    }
  }

  // --------------------------------------------------------------------------
  // Internal: helpers
  // --------------------------------------------------------------------------

  /** Build per-chain windows from the raw map, using `prefix` for key lookup. */
  private buildChainWindows(raw: Map<string, unknown>, prefix: string): Record<string, ChainWindows> {
    const chains: Record<string, ChainWindows> = {};
    const chainNames = ["stellar", "ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"];

    for (const chain of chainNames) {
      const deadlineKey = `${prefix}deadline_${chain}`;
      const fillKey = `${prefix}fill_window_${chain}`;

      if (!raw.has(deadlineKey) && !raw.has(fillKey)) {
        // Use code defaults for this chain — only store explicitly set values.
        chains[chain] = {
          deadlineSeconds: CHAIN_DEADLINE_DEFAULTS[chain] ?? DEFAULT_DEADLINE_SECONDS,
          fillWindowSeconds: CHAIN_FILL_WINDOW_DEFAULTS[chain] ?? DEFAULT_FILL_WINDOW_SECONDS,
        };
        continue;
      }

      const deadlineSeconds = this.parseAndClamp(
        raw,
        deadlineKey,
        PARAM_BOUNDS.deadlineSecondsMin,
        PARAM_BOUNDS.deadlineSecondsMax,
        CHAIN_DEADLINE_DEFAULTS[chain] ?? DEFAULT_DEADLINE_SECONDS,
        `chains.${chain}.deadlineSeconds`,
      );

      const fillWindowSeconds = this.parseAndClamp(
        raw,
        fillKey,
        PARAM_BOUNDS.fillWindowSecondsMin,
        PARAM_BOUNDS.fillWindowSecondsMax,
        CHAIN_FILL_WINDOW_DEFAULTS[chain] ?? DEFAULT_FILL_WINDOW_SECONDS,
        `chains.${chain}.fillWindowSeconds`,
      );

      chains[chain] = { deadlineSeconds, fillWindowSeconds };
    }

    return chains;
  }

  /**
   * Parse a value from the raw map as a number, clamp it to [min, max], and
   * log a loud error (without throwing) if it was out-of-bounds.
   *
   * @param isFloat - when true, parses as float instead of integer
   */
  private parseAndClamp(
    raw: Map<string, unknown>,
    key: string,
    min: number,
    max: number,
    fallback: number,
    paramName: string,
    isFloat = false,
  ): number {
    if (!raw.has(key)) return fallback;

    const raw_val = raw.get(key);
    const parsed = isFloat ? parseFloat(String(raw_val)) : parseInt(String(raw_val), 10);

    if (!Number.isFinite(parsed)) {
      this.logger.error(
        `[params] VALIDATION ALERT: ${paramName} = "${raw_val}" is not a finite number. ` +
          `Rejecting governance value; keeping fallback=${fallback}.`,
      );
      return fallback;
    }

    if (parsed < min || parsed > max) {
      this.logger.error(
        `[params] VALIDATION ALERT: ${paramName} = ${parsed} is outside bounds [${min}, ${max}]. ` +
          `Governance passed an insane value. Clamping to bounds.`,
      );
      return Math.min(max, Math.max(min, parsed));
    }

    return parsed;
  }

  /** Validate a slash amount string; return fallback on failure. */
  private validateSlashAmount(value: string): string {
    try {
      const bigVal = BigInt(value);
      const bigMin = BigInt(PARAM_BOUNDS.slashAmountMin);
      const bigMax = BigInt(PARAM_BOUNDS.slashAmountMax);

      if (bigVal < bigMin || bigVal > bigMax) {
        this.logger.error(
          `[params] VALIDATION ALERT: slashAmount = ${value} is outside bounds ` +
            `[${PARAM_BOUNDS.slashAmountMin}, ${PARAM_BOUNDS.slashAmountMax}]. Clamping.`,
        );
        const clamped = bigVal < bigMin ? bigMin : bigMax;
        return clamped.toString();
      }
      return bigVal.toString();
    } catch {
      this.logger.error(
        `[params] VALIDATION ALERT: slashAmount = "${value}" is not a valid integer. ` +
          `Keeping fallback=${DEFAULT_SLASH_AMOUNT}.`,
      );
      return DEFAULT_SLASH_AMOUNT;
    }
  }

  /**
   * Compare two ProtocolParams to detect if something meaningful changed.
   * Ignores version, activeSinceLedger, and adoptedAt (metadata fields).
   */
  private hasChanged(a: ProtocolParams, b: ProtocolParams): boolean {
    if (a.feeBps !== b.feeBps) return true;
    if (a.maxExposureRatio !== b.maxExposureRatio) return true;
    if (a.slashAmount !== b.slashAmount) return true;

    for (const chain of Object.keys(b.chains)) {
      const ac = a.chains[chain];
      const bc = b.chains[chain];
      if (!ac) return true;
      if (ac.deadlineSeconds !== bc.deadlineSeconds) return true;
      if (ac.fillWindowSeconds !== bc.fillWindowSeconds) return true;
    }
    return false;
  }

  /** Build the initial ProtocolParams from code / env defaults. */
  private buildCodeDefaults(): ProtocolParams {
    const chains: Record<string, ChainWindows> = {};
    for (const [chain, deadline] of Object.entries(CHAIN_DEADLINE_DEFAULTS)) {
      chains[chain] = {
        deadlineSeconds: deadline,
        fillWindowSeconds: CHAIN_FILL_WINDOW_DEFAULTS[chain] ?? DEFAULT_FILL_WINDOW_SECONDS,
      };
    }

    return {
      version: 0,
      feeBps: DEFAULT_FEE_BPS,
      chains,
      maxExposureRatio: DEFAULT_MAX_EXPOSURE_RATIO,
      slashAmount: DEFAULT_SLASH_AMOUNT,
      activeSinceLedger: 0,
      adoptedAt: new Date().toISOString(),
    };
  }
}
