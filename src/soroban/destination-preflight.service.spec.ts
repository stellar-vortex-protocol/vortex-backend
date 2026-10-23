import { Asset, Keypair, MuxedAccount, Account, Networks, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import {
  DestinationLedgerReader,
  DestinationPreflightError,
  DestinationPreflightService,
  HorizonAccountRecord,
  HorizonBalanceLine,
  HorizonSorobanLedgerReader,
  baseAccountId,
  toStroops,
} from "./destination-preflight.service";

const issuer = Keypair.random().publicKey();
const USDC = new Asset("USDC", issuer);
const USDC_SAC = USDC.contractId(Networks.TESTNET);
const NATIVE_SAC = Asset.native().contractId(Networks.TESTNET);
const CUSTOM_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));

function config(overrides: Partial<AppConfig["destinationPreflight"]> = {}): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    destinationPreflight: { enabled: true, failOpen: true, cacheTtlMs: 30_000, ...overrides },
    "stellar.network": "testnet",
    "stellar.horizonUrl": "https://horizon-testnet.stellar.org",
    "stellar.sorobanRpcUrl": "https://soroban-testnet.stellar.org",
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

function trustline(overrides: Partial<HorizonBalanceLine> = {}): HorizonBalanceLine {
  return {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: issuer,
    balance: "0.0000000",
    limit: "922337203685.4775807",
    buying_liabilities: "0.0000000",
    is_authorized: true,
    ...overrides,
  };
}

class FakeLedger implements DestinationLedgerReader {
  accounts = new Map<string, HorizonAccountRecord>();
  sacs = new Map<string, { code: string; issuer: string } | "native" | null>([
    [USDC_SAC, { code: "USDC", issuer }],
    [NATIVE_SAC, "native"],
    [CUSTOM_TOKEN, null],
  ]);
  contractAuth = new Map<string, boolean>();
  horizonDown = false;
  loadAccount = jest.fn(async (id: string) => {
    if (this.horizonDown) throw new Error("ECONNREFUSED");
    return this.accounts.get(id) ?? null;
  });
  sacUnderlyingAsset = jest.fn(async (id: string) => this.sacs.get(id) ?? null);
  contractHolderAuthorized = jest.fn(async (_c: string, holder: string) => this.contractAuth.get(holder) ?? null);

  withAccount(id: string, balances: HorizonBalanceLine[] = []): this {
    this.accounts.set(id, {
      account_id: id,
      balances: [{ asset_type: "native", balance: "100.0000000" }, ...balances],
    });
    return this;
  }
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(DestinationPreflightError);
    return (err as DestinationPreflightError).code;
  }
}

describe("DestinationPreflightService (issue #439)", () => {
  let ledger: FakeLedger;
  let user: string;

  beforeEach(() => {
    ledger = new FakeLedger();
    user = Keypair.random().publicKey();
  });

  const service = (overrides?: Partial<AppConfig["destinationPreflight"]>) =>
    new DestinationPreflightService(config(overrides), ledger);

  it("passes an account with an authorized trustline and enough headroom", async () => {
    ledger.withAccount(user, [trustline()]);
    await expect(service().assertDeliverable(user, USDC_SAC, "5000000")).resolves.toBeUndefined();
  });

  it("DST_ACCOUNT_NOT_FOUND when Horizon 404s the account", async () => {
    expect(await code(service().assertDeliverable(user, USDC_SAC, "1"))).toBe("DST_ACCOUNT_NOT_FOUND");
  });

  it("DST_TRUSTLINE_MISSING when the account has no line for the asset", async () => {
    ledger.withAccount(user, [trustline({ asset_issuer: Keypair.random().publicKey() })]);
    expect(await code(service().assertDeliverable(user, USDC_SAC, "1"))).toBe("DST_TRUSTLINE_MISSING");
  });

  it("DST_NOT_AUTHORIZED when the issuer has not authorized the trustline", async () => {
    ledger.withAccount(user, [trustline({ is_authorized: false, is_authorized_to_maintain_liabilities: true })]);
    expect(await code(service().assertDeliverable(user, USDC_SAC, "1"))).toBe("DST_NOT_AUTHORIZED");
  });

  it("DST_TRUSTLINE_LIMIT when limit − balance − buying liabilities < minDstAmount", async () => {
    // limit 10, balance 4, buying liabilities 1 → 5 units (50_000_000 stroops) of headroom.
    ledger.withAccount(user, [trustline({ limit: "10.0000000", balance: "4.0000000", buying_liabilities: "1.0000000" })]);
    const svc = service();
    await expect(svc.assertDeliverable(user, USDC_SAC, "50000000")).resolves.toBeUndefined();
    const err = await svc.assertDeliverable(user, USDC_SAC, "50000001").catch((e) => e);
    expect(err).toBeInstanceOf(DestinationPreflightError);
    expect(err.code).toBe("DST_TRUSTLINE_LIMIT");
    expect(err.getResponse()).toMatchObject({ code: "DST_TRUSTLINE_LIMIT", remainingLimit: "50000000" });
  });

  it("returns a 422 body with code and message at the top level", async () => {
    const err = (await service().assertDeliverable(user, USDC_SAC, "1").catch((e) => e)) as DestinationPreflightError;
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({
      error: "DST_ACCOUNT_NOT_FOUND",
      code: "DST_ACCOUNT_NOT_FOUND",
      message: expect.any(String),
      destination: user,
    });
  });

  it("native XLM needs no trustline, only an existing account", async () => {
    ledger.withAccount(user);
    await expect(service().assertDeliverable(user, NATIVE_SAC, "999999999999")).resolves.toBeUndefined();
    expect(await code(service().assertDeliverable(Keypair.random().publicKey(), NATIVE_SAC, "1"))).toBe(
      "DST_ACCOUNT_NOT_FOUND",
    );
  });

  it("the issuer receiving its own asset needs no trustline", async () => {
    ledger.withAccount(issuer);
    await expect(service().assertDeliverable(issuer, USDC_SAC, "1")).resolves.toBeUndefined();
  });

  it("a custom (non-SAC) Soroban token has no trustline concept", async () => {
    ledger.withAccount(user);
    await expect(service().assertDeliverable(user, CUSTOM_TOKEN, "1")).resolves.toBeUndefined();
  });

  it("checks a muxed (M…) destination against its underlying G… account", async () => {
    const muxed = new MuxedAccount(new Account(user, "0"), "42").accountId();
    expect(muxed.startsWith("M")).toBe(true);
    expect(baseAccountId(muxed)).toBe(user);
    ledger.withAccount(user, [trustline()]);
    await expect(service().assertDeliverable(muxed, USDC_SAC, "1")).resolves.toBeUndefined();
    expect(ledger.loadAccount).toHaveBeenCalledWith(user);
  });

  it("contract (C…) holders use the SAC balance-entry authorization, not a trustline", async () => {
    const holder = StrKey.encodeContract(Buffer.alloc(32, 9));
    ledger.contractAuth.set(holder, false);
    expect(await code(service().assertDeliverable(holder, USDC_SAC, "1"))).toBe("DST_NOT_AUTHORIZED");
    ledger.contractAuth.set(holder, true);
    await expect(service().assertDeliverable(holder, USDC_SAC, "1", { fresh: true })).resolves.toBeUndefined();
    expect(ledger.loadAccount).not.toHaveBeenCalled();
  });

  describe("cache", () => {
    it("serves repeat checks for the same (account, asset) from cache within the TTL", async () => {
      ledger.withAccount(user, [trustline()]);
      const svc = service({ cacheTtlMs: 1_000 });
      let now = 0;
      svc.setClock(() => now);
      await svc.assertDeliverable(user, USDC_SAC, "1");
      await svc.assertDeliverable(user, USDC_SAC, "2");
      expect(ledger.loadAccount).toHaveBeenCalledTimes(1);
      now = 1_001;
      await svc.assertDeliverable(user, USDC_SAC, "1");
      expect(ledger.loadAccount).toHaveBeenCalledTimes(2);
    });

    it("evaluates each minDstAmount against the cached snapshot", async () => {
      ledger.withAccount(user, [trustline({ limit: "1.0000000" })]);
      const svc = service();
      await expect(svc.assertDeliverable(user, USDC_SAC, "10000000")).resolves.toBeUndefined();
      expect(await code(svc.assertDeliverable(user, USDC_SAC, "10000001"))).toBe("DST_TRUSTLINE_LIMIT");
      expect(ledger.loadAccount).toHaveBeenCalledTimes(1);
    });

    it("fresh: true (accept time) bypasses the cache and sees a removed trustline", async () => {
      ledger.withAccount(user, [trustline()]);
      const svc = service();
      await svc.assertDeliverable(user, USDC_SAC, "1");
      ledger.withAccount(user); // trustline removed
      await expect(svc.assertDeliverable(user, USDC_SAC, "1")).resolves.toBeUndefined(); // cached
      expect(await code(svc.assertDeliverable(user, USDC_SAC, "1", { fresh: true }))).toBe("DST_TRUSTLINE_MISSING");
    });

    it("resolves a SAC's underlying asset once", async () => {
      ledger.withAccount(user, [trustline()]);
      const svc = service({ cacheTtlMs: 0 });
      await svc.assertDeliverable(user, USDC_SAC, "1");
      await svc.assertDeliverable(user, USDC_SAC, "1");
      expect(ledger.sacUnderlyingAsset).toHaveBeenCalledTimes(1);
    });

    it("invalidate() drops a destination's snapshots", async () => {
      ledger.withAccount(user, [trustline()]);
      const svc = service();
      await svc.assertDeliverable(user, USDC_SAC, "1");
      svc.invalidate(user);
      await svc.assertDeliverable(user, USDC_SAC, "1");
      expect(ledger.loadAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe("availability", () => {
    it("fails open (logged) when Horizon is down and DST_PREFLIGHT_FAIL_OPEN=true", async () => {
      ledger.horizonDown = true;
      await expect(service().check(user, USDC_SAC, "1")).resolves.toEqual({ ok: true, skipped: "unavailable" });
    });

    it("fails closed when DST_PREFLIGHT_FAIL_OPEN=false", async () => {
      ledger.horizonDown = true;
      await expect(service({ failOpen: false }).check(user, USDC_SAC, "1")).rejects.toThrow("ECONNREFUSED");
    });

    it("does nothing when disabled", async () => {
      await expect(service({ enabled: false }).check(user, USDC_SAC, "1")).resolves.toEqual({
        ok: true,
        skipped: "disabled",
      });
      expect(ledger.loadAccount).not.toHaveBeenCalled();
    });
  });
});

describe("toStroops", () => {
  it.each([
    ["0", 0n],
    ["1", 10_000_000n],
    ["1.5", 15_000_000n],
    ["922337203685.4775807", 9_223_372_036_854_775_807n],
    ["0.00000001", 0n], // sub-stroop precision truncates
    ["garbage", 0n],
  ])("%s → %s", (input, expected) => {
    expect(toStroops(input)).toBe(expected);
  });
});

describe("HorizonSorobanLedgerReader", () => {
  function reader() {
    const r = new HorizonSorobanLedgerReader(
      "https://horizon-testnet.stellar.org",
      "https://soroban-testnet.stellar.org",
      Networks.TESTNET,
    );
    const internals = r as unknown as {
      egress: { fetch: jest.Mock };
      simulate: jest.Mock;
    };
    internals.egress = { fetch: jest.fn() };
    internals.simulate = jest.fn();
    return { r, internals };
  }

  it("maps Horizon 404 to null and other non-2xx to a thrown error", async () => {
    const { r, internals } = reader();
    internals.egress.fetch.mockResolvedValueOnce({ statusCode: 404, body: "" });
    await expect(r.loadAccount("GX")).resolves.toBeNull();
    internals.egress.fetch.mockResolvedValueOnce({ statusCode: 503, body: "" });
    await expect(r.loadAccount("GX")).rejects.toThrow("503");
  });

  it("accepts a SAC name only when the contract id really derives from that asset", async () => {
    const { r, internals } = reader();
    internals.simulate.mockResolvedValue(nativeToScVal(`USDC:${issuer}`, { type: "string" }));
    await expect(r.sacUnderlyingAsset(USDC_SAC)).resolves.toEqual({ code: "USDC", issuer });
    // A custom token that merely *names* itself USDC:ISSUER is not that SAC.
    await expect(r.sacUnderlyingAsset(CUSTOM_TOKEN)).resolves.toBeNull();
  });

  it("recognises the native SAC", async () => {
    const { r, internals } = reader();
    internals.simulate.mockResolvedValue(nativeToScVal("native", { type: "string" }));
    await expect(r.sacUnderlyingAsset(NATIVE_SAC)).resolves.toBe("native");
  });

  it("reads SAC authorized(holder)", async () => {
    const { r, internals } = reader();
    internals.simulate.mockResolvedValue(nativeToScVal(false));
    await expect(r.contractHolderAuthorized(USDC_SAC, StrKey.encodeContract(Buffer.alloc(32, 1)))).resolves.toBe(false);
  });
});
