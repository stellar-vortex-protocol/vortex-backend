import { Inject, Injectable, Optional, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Address,
  Asset,
  Contract,
  MuxedAccount,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig, NETWORK_PASSPHRASES } from "../config/configuration";
import { EgressPurpose, HttpEgressService } from "../common/http-egress";
import { createLogger } from "../common/logger";
import { retvalFromSimulation } from "../tokens/verification/sdk-sac.simulator";
import { scValToString } from "../tokens/verification/simulated-sac.reader";

/**
 * Machine-readable reasons a Stellar destination cannot receive an intent's
 * delivery (issue #439). Returned to clients as `code` on a 422 and stable
 * across releases — wallets branch on them to show a "create trustline" CTA.
 */
export const DESTINATION_PREFLIGHT_CODES = [
  "DST_ACCOUNT_NOT_FOUND",
  "DST_TRUSTLINE_MISSING",
  "DST_TRUSTLINE_LIMIT",
  "DST_NOT_AUTHORIZED",
] as const;

export type DestinationPreflightCode = (typeof DESTINATION_PREFLIGHT_CODES)[number];

const MESSAGES: Record<DestinationPreflightCode, string> = {
  DST_ACCOUNT_NOT_FOUND: "Destination Stellar account does not exist — fund it with XLM first",
  DST_TRUSTLINE_MISSING: "Destination account has no trustline for the destination asset",
  DST_TRUSTLINE_LIMIT: "Destination trustline's remaining limit is below minDstAmount",
  DST_NOT_AUTHORIZED: "Destination account is not authorized by the asset issuer to hold the destination asset",
};

/** Human-readable explanation of a preflight code. */
export function destinationPreflightMessage(code: DestinationPreflightCode): string {
  return MESSAGES[code];
}

/** 422 carrying a {@link DestinationPreflightCode}. */
export class DestinationPreflightError extends UnprocessableEntityException {
  constructor(
    readonly code: DestinationPreflightCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    // No `statusCode` key: HttpExceptionFilter passes `{ error, ... }` bodies
    // through verbatim, so clients see `code` at the top level.
    super({ error: code, code, message: MESSAGES[code], ...detail });
  }
}

/** One classic balance line, as Horizon's `GET /accounts/{id}` returns it. */
export interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

/** The parts of a Horizon account record the preflight needs. */
export interface HorizonAccountRecord {
  account_id: string;
  balances: HorizonBalanceLine[];
}

/**
 * Read-only ledger access behind the preflight. Production uses Horizon and
 * Soroban RPC simulation; tests inject fixtures and never touch the network.
 */
export interface DestinationLedgerReader {
  /** The account, or `null` when Horizon answers 404. Throws when Horizon is unavailable. */
  loadAccount(accountId: string): Promise<HorizonAccountRecord | null>;
  /**
   * The classic asset a Stellar Asset Contract wraps, from the SAC's `name()`
   * (`"CODE:ISSUER"` or `"native"`). `null` means the contract is not a SAC —
   * a custom Soroban token with no trustline concept.
   */
  sacUnderlyingAsset(contractId: string): Promise<{ code: string; issuer: string } | "native" | null>;
  /**
   * SAC `authorized(holder)` for a contract (`C…`) holder, whose balance lives
   * in a contract-data entry rather than a trustline. `null` when it could not
   * be determined.
   */
  contractHolderAuthorized(contractId: string, holder: string): Promise<boolean | null>;
}

/** Injection token for a custom {@link DestinationLedgerReader} (tests, alternative backends). */
export const DESTINATION_LEDGER_READER = Symbol("DESTINATION_LEDGER_READER");

/** Normalised destination asset. */
type DestinationAsset =
  | { kind: "native" }
  | { kind: "classic"; code: string; issuer: string; sacContractId?: string }
  | { kind: "contract"; contractId: string };

/** Snapshot of one (account, asset) pair — cached; amounts in stroops. */
interface TrustlineSnapshot {
  accountExists: boolean;
  /** `undefined` when the asset needs no trustline (native, issuer, custom contract). */
  trustline?: {
    exists: boolean;
    authorized: boolean;
    /** limit − balance − buying liabilities, in base units (7 dp). */
    remaining: bigint;
  };
  /** For contract holders of a SAC: `authorized(holder)`. */
  contractAuthorized?: boolean | null;
}

/** Outcome of a preflight run. */
export type DestinationPreflightResult =
  | { ok: true; skipped?: "disabled" | "unavailable" }
  | { ok: false; code: DestinationPreflightCode; detail: Record<string, unknown> };

export interface DestinationPreflightOptions {
  /** Bypass the cache — used at accept time, where a stale "ok" would let a doomed fill through. */
  fresh?: boolean;
}

const CLASSIC_DECIMALS = 7;

/**
 * Destination account + trustline preflight for Stellar deliveries (issue #439).
 *
 * Before an intent enters the open book — and again when a solver accepts it —
 * check that the user's Stellar account can actually receive `minDstAmount` of
 * the destination asset. Without this a solver's fill fails on-chain, wasting
 * their funds and time and possibly getting them slashed for a delivery that
 * could never have landed.
 *
 * Checks, in order:
 *  1. the account exists (`DST_ACCOUNT_NOT_FOUND`);
 *  2. for a classic asset (or the SAC wrapping one), the account holds a
 *     trustline (`DST_TRUSTLINE_MISSING`), the issuer has authorized it
 *     (`DST_NOT_AUTHORIZED`), and limit − balance − buying liabilities ≥
 *     `minDstAmount` (`DST_TRUSTLINE_LIMIT`);
 *  3. for a contract (`C…`) destination of a SAC, the SAC's
 *     `authorized(holder)` balance-entry flag.
 *
 * Native XLM needs no trustline; an issuer receiving its own asset needs none
 * either; a custom (non-SAC) Soroban token has no trustline concept. Muxed
 * (`M…`) destinations are checked against their underlying `G…` account.
 *
 * Results per `(account, asset)` are cached for `DST_PREFLIGHT_CACHE_TTL_MS`
 * to bound Horizon load; `minDstAmount` is evaluated against the cached
 * snapshot, so one cache entry serves intents of any size.
 *
 * When Horizon is unavailable the preflight fails open by default
 * (`DST_PREFLIGHT_FAIL_OPEN=true`): an outage must not halt intent creation.
 */
@Injectable()
export class DestinationPreflightService {
  private readonly log = createLogger(DestinationPreflightService.name, { chain: "stellar" });
  private readonly enabled: boolean;
  private readonly failOpen: boolean;
  private readonly ttlMs: number;
  private readonly nativeContractId: string;
  private readonly reader: DestinationLedgerReader;
  private readonly cache = new Map<string, { snapshot: TrustlineSnapshot; expiresAt: number }>();
  /** SAC → underlying asset is immutable, so it is cached for the process lifetime. */
  private readonly sacAssets = new Map<string, DestinationAsset>();
  private now: () => number = Date.now;

  constructor(
    config: ConfigService<AppConfig, true>,
    @Optional() @Inject(DESTINATION_LEDGER_READER) reader?: DestinationLedgerReader,
  ) {
    const settings = config.get("destinationPreflight", { infer: true });
    this.enabled = settings?.enabled ?? false;
    this.failOpen = settings?.failOpen ?? true;
    this.ttlMs = settings?.cacheTtlMs ?? 30_000;
    const network = config.get("stellar.network", { infer: true });
    this.nativeContractId = Asset.native().contractId(NETWORK_PASSPHRASES[network]);
    this.reader =
      reader ??
      new HorizonSorobanLedgerReader(
        config.get("stellar.horizonUrl", { infer: true }),
        config.get("stellar.sorobanRpcUrl", { infer: true }),
        NETWORK_PASSPHRASES[network],
      );
  }

  /** Test seam: freeze or advance the clock used for cache expiry. */
  setClock(now: () => number): void {
    this.now = now;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Run the preflight and return a result instead of throwing — for callers
   * that want to notify rather than reject.
   */
  async check(
    destination: string,
    dstAssetContract: string,
    minDstAmount: string,
    options: DestinationPreflightOptions = {},
  ): Promise<DestinationPreflightResult> {
    if (!this.enabled) return { ok: true, skipped: "disabled" };

    const account = baseAccountId(destination);
    let asset: DestinationAsset;
    let snapshot: TrustlineSnapshot;
    try {
      asset = await this.resolveAsset(dstAssetContract);
      snapshot = await this.snapshot(account, asset, options.fresh === true);
    } catch (err) {
      this.log.warn("destination preflight unavailable", {
        destination: account,
        asset: dstAssetContract,
        failOpen: this.failOpen,
        err,
      });
      if (this.failOpen) return { ok: true, skipped: "unavailable" };
      throw err;
    }

    const detail = { destination: account, dstToken: dstAssetContract };
    if (!snapshot.accountExists) return { ok: false, code: "DST_ACCOUNT_NOT_FOUND", detail };
    if (snapshot.contractAuthorized === false) return { ok: false, code: "DST_NOT_AUTHORIZED", detail };

    const line = snapshot.trustline;
    if (line) {
      if (!line.exists) return { ok: false, code: "DST_TRUSTLINE_MISSING", detail };
      if (!line.authorized) return { ok: false, code: "DST_NOT_AUTHORIZED", detail };
      let required: bigint;
      try {
        required = BigInt(minDstAmount);
      } catch {
        required = 0n;
      }
      if (line.remaining < required) {
        return {
          ok: false,
          code: "DST_TRUSTLINE_LIMIT",
          detail: { ...detail, remainingLimit: line.remaining.toString(), minDstAmount },
        };
      }
    }
    return { ok: true };
  }

  /** {@link check}, throwing {@link DestinationPreflightError} on failure. */
  async assertDeliverable(
    destination: string,
    dstAssetContract: string,
    minDstAmount: string,
    options: DestinationPreflightOptions = {},
  ): Promise<void> {
    const result = await this.check(destination, dstAssetContract, minDstAmount, options);
    if (!result.ok) {
      this.log.info("destination preflight rejected", { code: result.code, ...result.detail });
      throw new DestinationPreflightError(result.code, result.detail);
    }
  }

  /** Drop cached snapshots, e.g. after a user reports adding a trustline. */
  invalidate(destination?: string): void {
    if (!destination) {
      this.cache.clear();
      return;
    }
    const prefix = `${baseAccountId(destination)}|`;
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  private async resolveAsset(contract: string): Promise<DestinationAsset> {
    const trimmed = contract.trim();
    if (trimmed === this.nativeContractId || trimmed === "native" || trimmed.toUpperCase() === "XLM") {
      return { kind: "native" };
    }
    const classic = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(trimmed);
    if (classic) return { kind: "classic", code: classic[1], issuer: classic[2] };

    const cached = this.sacAssets.get(trimmed);
    if (cached) return cached;
    const underlying = await this.reader.sacUnderlyingAsset(trimmed);
    const resolved: DestinationAsset =
      underlying === "native"
        ? { kind: "native" }
        : underlying
          ? { kind: "classic", code: underlying.code, issuer: underlying.issuer, sacContractId: trimmed }
          : { kind: "contract", contractId: trimmed };
    this.sacAssets.set(trimmed, resolved);
    return resolved;
  }

  private async snapshot(account: string, asset: DestinationAsset, fresh: boolean): Promise<TrustlineSnapshot> {
    const key = `${account}|${assetKey(asset)}`;
    const now = this.now();
    if (!fresh) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > now) return hit.snapshot;
    }
    const snapshot = await this.load(account, asset);
    this.cache.set(key, { snapshot, expiresAt: now + this.ttlMs });
    return snapshot;
  }

  private async load(account: string, asset: DestinationAsset): Promise<TrustlineSnapshot> {
    // Contract destinations hold SAC balances in contract data, not trustlines.
    if (StrKey.isValidContract(account)) {
      if (asset.kind === "contract" || asset.kind === "native") return { accountExists: true };
      const authorized = asset.sacContractId
        ? await this.reader.contractHolderAuthorized(asset.sacContractId, account)
        : null;
      return { accountExists: true, contractAuthorized: authorized };
    }

    const record = await this.reader.loadAccount(account);
    if (!record) return { accountExists: false };
    if (asset.kind !== "classic" || asset.issuer === account) return { accountExists: true };

    const line = record.balances.find(
      (b) =>
        (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
        b.asset_code === asset.code &&
        b.asset_issuer === asset.issuer,
    );
    if (!line) return { accountExists: true, trustline: { exists: false, authorized: false, remaining: 0n } };

    const limit = toStroops(line.limit ?? "0");
    const balance = toStroops(line.balance);
    const buying = toStroops(line.buying_liabilities ?? "0");
    const remaining = limit - balance - buying;
    return {
      accountExists: true,
      trustline: {
        exists: true,
        // `is_authorized_to_maintain_liabilities` alone cannot *receive*.
        authorized: line.is_authorized !== false,
        remaining: remaining > 0n ? remaining : 0n,
      },
    };
  }

}

/** Underlying `G…` account of a muxed `M…` address; anything else unchanged. */
export function baseAccountId(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("M") && StrKey.isValidMed25519PublicKey(trimmed)) {
    return MuxedAccount.fromAddress(trimmed, "0").baseAccount().accountId();
  }
  return trimmed;
}

function assetKey(asset: DestinationAsset): string {
  if (asset.kind === "native") return "native";
  if (asset.kind === "classic") return `${asset.code}:${asset.issuer}`;
  return asset.contractId;
}

/** Horizon decimal amount ("12.3400000") → base units at 7 decimals. */
export function toStroops(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return 0n;
  const fraction = (match[2] ?? "").slice(0, CLASSIC_DECIMALS).padEnd(CLASSIC_DECIMALS, "0");
  return BigInt(match[1]) * 10n ** BigInt(CLASSIC_DECIMALS) + BigInt(fraction);
}

/**
 * Production {@link DestinationLedgerReader}: Horizon for accounts and
 * trustlines, read-only Soroban simulation for SAC metadata. Nothing is
 * signed or submitted.
 */
export class HorizonSorobanLedgerReader implements DestinationLedgerReader {
  private readonly horizonBase: string;
  private readonly egress: HttpEgressService;
  private readonly rpc: SorobanRpc.Server;
  /** Envelope source for simulations only; any well-formed account id works. */
  private static readonly SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  constructor(
    horizonUrl: string,
    rpcUrl: string,
    private readonly passphrase: string,
  ) {
    this.horizonBase = horizonUrl.replace(/\/$/, "");
    this.egress = new HttpEgressService({
      timeoutMs: 5_000,
      maxRedirects: 0,
      maxBodySizeBytes: 1_048_576,
      allowlist: [new URL(horizonUrl).hostname],
      blockPrivateRanges: false,
    });
    this.rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  async loadAccount(accountId: string): Promise<HorizonAccountRecord | null> {
    const response = await this.egress.fetch(`${this.horizonBase}/accounts/${encodeURIComponent(accountId)}`, {
      purpose: EgressPurpose.HORIZON,
    });
    if (response.statusCode === 404) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Horizon returned ${response.statusCode} for account lookup`);
    }
    return JSON.parse(response.body) as HorizonAccountRecord;
  }

  async sacUnderlyingAsset(contractId: string): Promise<{ code: string; issuer: string } | "native" | null> {
    const retval = await this.simulate(contractId, "name", []);
    const name = retval ? scValToString(retval) : null;
    if (!name) return null;
    if (name === "native") return "native";
    const match = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
    if (!match) return null;
    // A custom token can name itself "CODE:ISSUER"; only a real SAC's contract
    // id is derived from that asset, so confirm before trusting the name.
    try {
      if (new Asset(match[1], match[2]).contractId(this.passphrase) !== contractId) return null;
    } catch {
      return null;
    }
    return { code: match[1], issuer: match[2] };
  }

  async contractHolderAuthorized(contractId: string, holder: string): Promise<boolean | null> {
    const retval = await this.simulate(contractId, "authorized", [new Address(holder).toScVal()]);
    if (!retval) return null;
    const value = scValToNative(retval);
    return typeof value === "boolean" ? value : null;
  }

  private async simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
    const tx = new TransactionBuilder(new Account(HorizonSorobanLedgerReader.SIM_SOURCE, "0"), {
      fee: "100",
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    return retvalFromSimulation(await this.rpc.simulateTransaction(tx));
  }
}
