/**
 * Unit tests for ProtocolParamsService (issue #500).
 *
 * Tests cover:
 * - Code-default initialisation (no contract configured)
 * - Successful on-chain parameter adoption
 * - "Contract unreachable" → last-known values retained, never falls back silently
 * - Validation bounds enforcement (insane governance values clamped / rejected)
 * - Version counter increments only on meaningful change
 * - History ring-buffer management
 * - Pending change lifecycle (observed → cleared after execution ledger passes)
 * - snapshotForChain() picks correct per-chain windows
 * - Time-travel tests around activation boundaries (execution ledger)
 */

import { ConfigService } from "@nestjs/config";
import {
  ProtocolParamsService,
  PARAM_BOUNDS,
  ProtocolParams,
  ParamsSnapshot,
} from "./params.service";
import {
  AppConfig,
  CHAIN_DEADLINE_DEFAULTS,
  CHAIN_FILL_WINDOW_DEFAULTS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_FILL_WINDOW_SECONDS,
} from "../config/configuration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, unknown> = {}): ConfigService<AppConfig, true> {
  const defaults: Record<string, unknown> = {
    "governance.paramsContractId": "",
    "governance.paramsPollIntervalMs": 30_000,
    "stellar.sorobanRpcUrl": "https://soroban-testnet.stellar.org",
    ...overrides,
  };
  return {
    get: jest.fn().mockImplementation((key: string) => defaults[key]),
  } as unknown as ConfigService<AppConfig, true>;
}

/** Build a minimal ProtocolParamsService with polling disabled. */
function makeService(configOverrides: Record<string, unknown> = {}): ProtocolParamsService {
  const cs = makeConfigService(configOverrides);
  const svc = new ProtocolParamsService(cs);
  return svc;
}

/** Access private members for testing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(svc: ProtocolParamsService): any {
  return svc as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Code defaults
// ---------------------------------------------------------------------------

describe("ProtocolParamsService — code defaults", () => {
  it("starts with version 0 and code-default feeBps", () => {
    const svc = makeService();
    const current = svc.getCurrent();
    expect(current.version).toBe(0);
    expect(current.feeBps).toBe(30); // DEFAULT_FEE_BPS
  });

  it("starts with null pending change", () => {
    const svc = makeService();
    expect(svc.getPending()).toBeNull();
  });

  it("starts with empty history", () => {
    const svc = makeService();
    expect(svc.getHistory()).toEqual([]);
  });

  it("populates per-chain windows from CHAIN_DEADLINE_DEFAULTS", () => {
    const svc = makeService();
    const current = svc.getCurrent();
    for (const [chain, deadline] of Object.entries(CHAIN_DEADLINE_DEFAULTS)) {
      expect(current.chains[chain]?.deadlineSeconds).toBe(deadline);
    }
  });

  it("populates per-chain fill windows from CHAIN_FILL_WINDOW_DEFAULTS", () => {
    const svc = makeService();
    const current = svc.getCurrent();
    for (const [chain, fillWindow] of Object.entries(CHAIN_FILL_WINDOW_DEFAULTS)) {
      expect(current.chains[chain]?.fillWindowSeconds).toBe(fillWindow);
    }
  });
});

// ---------------------------------------------------------------------------
// onModuleInit without contract
// ---------------------------------------------------------------------------

describe("onModuleInit — no contract configured", () => {
  it("does not throw and leaves current on code defaults", async () => {
    const svc = makeService({ "governance.paramsContractId": "" });
    await expect(svc.onModuleInit()).resolves.not.toThrow();
    expect(svc.getCurrent().version).toBe(0);
    // Clear the poll timer so Jest doesn't complain about open handles
    svc.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// applyContractState — happy path
// ---------------------------------------------------------------------------

describe("applyContractState — valid on-chain values", () => {
  async function applyRaw(
    svc: ProtocolParamsService,
    raw: Map<string, unknown>,
  ): Promise<void> {
    // Stub the private rpcServer's getLatestLedger
    priv(svc).rpcServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1_000_000 }),
    };
    await priv(svc).applyContractState(raw);
  }

  it("adopts a new feeBps from on-chain and bumps version to 1", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fee_bps", 50]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().feeBps).toBe(50);
    expect(svc.getCurrent().version).toBe(1);
  });

  it("does NOT bump version when nothing changed", async () => {
    const svc = makeService();
    // First application — feeBps 30 matches the code default, so no change
    const raw = new Map<string, unknown>([["fee_bps", 30]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().version).toBe(0);
  });

  it("pushes old params to history on change", async () => {
    const svc = makeService();
    const firstVersion = { ...svc.getCurrent() };
    const raw = new Map<string, unknown>([["fee_bps", 75]]);
    await applyRaw(svc, raw);
    const history = svc.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].feeBps).toBe(firstVersion.feeBps);
  });

  it("sets activeSinceLedger to the current ledger on adoption", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fee_bps", 80]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().activeSinceLedger).toBe(1_000_000);
  });

  it("adopts per-chain deadline overrides from on-chain values", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["fee_bps", 30],           // same as default — only chain change should bump
      ["deadline_stellar", 600],  // change from 900
    ]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().chains["stellar"]?.deadlineSeconds).toBe(600);
    expect(svc.getCurrent().version).toBe(1); // changed
  });

  it("adopts per-chain fill-window overrides", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["fill_window_ethereum", 2400], // change from 1800
    ]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().chains["ethereum"]?.fillWindowSeconds).toBe(2400);
  });

  it("adopts maxExposureRatio and slashAmount", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["max_exposure_ratio", 0.08],
      ["slash_amount", "200000000"],
    ]);
    await applyRaw(svc, raw);
    const curr = svc.getCurrent();
    expect(curr.maxExposureRatio).toBe(0.08);
    expect(curr.slashAmount).toBe("200000000");
  });
});

// ---------------------------------------------------------------------------
// Validation bounds — out-of-range values
// ---------------------------------------------------------------------------

describe("Validation bounds enforcement", () => {
  async function applyRaw(
    svc: ProtocolParamsService,
    raw: Map<string, unknown>,
  ): Promise<void> {
    priv(svc).rpcServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1_000_000 }),
    };
    await priv(svc).applyContractState(raw);
  }

  it("clamps feeBps above feeBpsMax (1000) to 1000", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fee_bps", 9999]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().feeBps).toBe(PARAM_BOUNDS.feeBpsMax);
  });

  it("clamps feeBps below 0 to 0", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fee_bps", -5]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().feeBps).toBe(0);
  });

  it("clamps deadlineSeconds above max (86400) to 86400", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["deadline_stellar", 999_999]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().chains["stellar"]?.deadlineSeconds).toBe(PARAM_BOUNDS.deadlineSecondsMax);
  });

  it("clamps deadlineSeconds below min (60) to 60", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["deadline_ethereum", 1]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().chains["ethereum"]?.deadlineSeconds).toBe(PARAM_BOUNDS.deadlineSecondsMin);
  });

  it("clamps fillWindowSeconds above max (43200) to 43200", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fill_window_stellar", 999_999]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().chains["stellar"]?.fillWindowSeconds).toBe(PARAM_BOUNDS.fillWindowSecondsMax);
  });

  it("clamps fillWindowSeconds below min (30) to 30", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fill_window_base", 0]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().chains["base"]?.fillWindowSeconds).toBe(PARAM_BOUNDS.fillWindowSecondsMin);
  });

  it("clamps slashAmount above max", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["fee_bps", 30],
      ["slash_amount", "9999999999999999"],
    ]);
    await applyRaw(svc, raw);
    expect(BigInt(svc.getCurrent().slashAmount)).toBeLessThanOrEqual(
      BigInt(PARAM_BOUNDS.slashAmountMax),
    );
  });

  it("keeps fallback when slashAmount is not a valid integer", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["slash_amount", "not-a-number"]]);
    await applyRaw(svc, raw);
    // Should keep the DEFAULT_SLASH_AMOUNT fallback
    expect(svc.getCurrent().slashAmount).toBe("100000000");
  });

  it("keeps fallback when feeBps is not a finite number", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([["fee_bps", NaN]]);
    await applyRaw(svc, raw);
    expect(svc.getCurrent().feeBps).toBe(30); // fallback = DEFAULT_FEE_BPS
  });
});

// ---------------------------------------------------------------------------
// Contract unreachable — retain last-known values
// ---------------------------------------------------------------------------

describe("Contract unreachable — keep last-known values", () => {
  it("retains last-known params when RPC throws", async () => {
    const svc = makeService({ "governance.paramsContractId": "CFAKE000000000000000000000000000000000000000000000000001" });

    // Manually set an "already adopted" state (simulating a previous success)
    priv(svc).current = {
      version: 5,
      feeBps: 42,
      chains: {},
      maxExposureRatio: 0.1,
      slashAmount: "500",
      activeSinceLedger: 999,
      adoptedAt: new Date().toISOString(),
    } as ProtocolParams;
    priv(svc).versionCounter = 5;

    // Wire the rpcServer to throw
    priv(svc).rpcServer = {
      getLedgerEntries: jest.fn().mockRejectedValue(new Error("network error")),
      getLatestLedger: jest.fn().mockRejectedValue(new Error("network error")),
    };

    await svc.refresh();

    // Must still return the last-known params, not revert to code defaults
    expect(svc.getCurrent().feeBps).toBe(42);
    expect(svc.getCurrent().version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Pending changes + timelock boundary tests
// ---------------------------------------------------------------------------

describe("Pending change lifecycle", () => {
  async function applyRaw(
    svc: ProtocolParamsService,
    raw: Map<string, unknown>,
    currentLedger = 1_000_000,
  ): Promise<void> {
    priv(svc).rpcServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: currentLedger }),
    };
    await priv(svc).applyContractState(raw);
  }

  it("sets a pending change when execution ledger is in the future", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["pending_fee_bps", 100],
      ["pending_execution_ledger", 1_001_000], // 1000 ledgers in future
    ]);
    await applyRaw(svc, raw, 1_000_000);
    const pending = svc.getPending();
    expect(pending).not.toBeNull();
    expect(pending!.params.feeBps).toBe(100);
    expect(pending!.executionLedger).toBe(1_001_000);
  });

  it("computes estimatedEta as roughly (ledgersUntilExec * 5s) from now", async () => {
    const before = Date.now();
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["pending_fee_bps", 150],
      ["pending_execution_ledger", 1_000_600], // 600 ledgers * 5s = 3000s
    ]);
    await applyRaw(svc, raw, 1_000_000);
    const pending = svc.getPending();
    expect(pending).not.toBeNull();

    const eta = new Date(pending!.estimatedEta).getTime();
    // ETA should be ~3000 s ahead of `before`
    expect(eta - before).toBeGreaterThan(2_990_000); // > 2990 s
    expect(eta - before).toBeLessThan(3_010_000);    // < 3010 s
  });

  it("clears pending when execution ledger has passed (time-travel: execution ledger reached)", async () => {
    const svc = makeService();

    // First: execution ledger is in the future
    const rawFuture = new Map<string, unknown>([
      ["pending_fee_bps", 200],
      ["pending_execution_ledger", 1_001_000],
    ]);
    await applyRaw(svc, rawFuture, 1_000_000);
    expect(svc.getPending()).not.toBeNull();

    // Time-travel: current ledger is now past the execution ledger
    // and the pending key is gone (contract deleted it after execution)
    const rawAfter = new Map<string, unknown>([
      ["fee_bps", 200], // new active value
    ]);
    await applyRaw(svc, rawAfter, 1_001_500);
    expect(svc.getPending()).toBeNull();
  });

  it("preserves observedAt across re-polls while change is still pending", async () => {
    const svc = makeService();
    const raw = new Map<string, unknown>([
      ["pending_fee_bps", 300],
      ["pending_execution_ledger", 2_000_000],
    ]);
    await applyRaw(svc, raw, 1_000_000);
    const firstObservedAt = svc.getPending()!.observedAt;

    // Second poll — still pending
    await applyRaw(svc, raw, 1_000_100);
    expect(svc.getPending()!.observedAt).toBe(firstObservedAt);
  });

  it("time-travel: new params take effect exactly at execution ledger", async () => {
    const svc = makeService();
    const executionLedger = 1_001_000;

    // Before execution ledger: pending change present, current unchanged
    const rawBefore = new Map<string, unknown>([
      ["fee_bps", 30],
      ["pending_fee_bps", 75],
      ["pending_execution_ledger", executionLedger],
    ]);
    await applyRaw(svc, rawBefore, executionLedger - 1);
    expect(svc.getCurrent().feeBps).toBe(30);
    expect(svc.getPending()).not.toBeNull();

    // At execution ledger: contract adopts the new value as current
    const rawAtExec = new Map<string, unknown>([
      ["fee_bps", 75], // governance has executed, new value is now current
      // pending_execution_ledger is no longer present (consumed by contract)
    ]);
    await applyRaw(svc, rawAtExec, executionLedger);
    expect(svc.getCurrent().feeBps).toBe(75);
    expect(svc.getPending()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// History ring-buffer
// ---------------------------------------------------------------------------

describe("History ring-buffer", () => {
  async function applyRaw(
    svc: ProtocolParamsService,
    raw: Map<string, unknown>,
  ): Promise<void> {
    priv(svc).rpcServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
    };
    await priv(svc).applyContractState(raw);
  }

  it("keeps history newest-first", async () => {
    const svc = makeService();
    await applyRaw(svc, new Map([["fee_bps", 10]]));
    await applyRaw(svc, new Map([["fee_bps", 20]]));
    await applyRaw(svc, new Map([["fee_bps", 30]]));

    const h = svc.getHistory();
    // Newest pushed last but getHistory returns reversed — newest first
    expect(h[0].feeBps).toBe(20); // was current before feeBps=30
    expect(h[1].feeBps).toBe(10); // was current before feeBps=20
    // Original code-default (feeBps=30) was pushed first
    expect(h[2].feeBps).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// snapshotForChain
// ---------------------------------------------------------------------------

describe("snapshotForChain()", () => {
  it("returns correct version and feeBps from current params", () => {
    const svc = makeService();
    const snapshot: ParamsSnapshot = svc.snapshotForChain("stellar");
    expect(snapshot.version).toBe(svc.getCurrent().version);
    expect(snapshot.feeBps).toBe(svc.getCurrent().feeBps);
  });

  it("returns the correct per-chain deadline for a known chain", () => {
    const svc = makeService();
    const snapshot = svc.snapshotForChain("stellar");
    expect(snapshot.deadlineSeconds).toBe(CHAIN_DEADLINE_DEFAULTS["stellar"]);
  });

  it("returns the correct per-chain fill window for a known chain", () => {
    const svc = makeService();
    const snapshot = svc.snapshotForChain("ethereum");
    expect(snapshot.fillWindowSeconds).toBe(CHAIN_FILL_WINDOW_DEFAULTS["ethereum"]);
  });

  it("falls back to DEFAULT_DEADLINE_SECONDS for an unknown chain", () => {
    const svc = makeService();
    const snapshot = svc.snapshotForChain("unknown-chain");
    expect(snapshot.deadlineSeconds).toBe(DEFAULT_DEADLINE_SECONDS);
  });

  it("falls back to DEFAULT_FILL_WINDOW_SECONDS for an unknown chain", () => {
    const svc = makeService();
    const snapshot = svc.snapshotForChain("unknown-chain");
    expect(snapshot.fillWindowSeconds).toBe(DEFAULT_FILL_WINDOW_SECONDS);
  });

  it("includes a capturedAt ISO timestamp", () => {
    const svc = makeService();
    const before = new Date().toISOString();
    const snapshot = svc.snapshotForChain("base");
    const after = new Date().toISOString();
    expect(snapshot.capturedAt >= before).toBe(true);
    expect(snapshot.capturedAt <= after).toBe(true);
  });

  it("reflects updated governance values after applyContractState", async () => {
    const svc = makeService();
    priv(svc).rpcServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1_000_000 }),
    };
    const raw = new Map<string, unknown>([
      ["fee_bps", 99],
      ["deadline_stellar", 300],
      ["fill_window_stellar", 60],
    ]);
    await priv(svc).applyContractState(raw);

    const snapshot = svc.snapshotForChain("stellar");
    expect(snapshot.feeBps).toBe(99);
    expect(snapshot.deadlineSeconds).toBe(300);
    expect(snapshot.fillWindowSeconds).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// PARAM_BOUNDS export
// ---------------------------------------------------------------------------

describe("PARAM_BOUNDS sanity checks", () => {
  it("feeBpsMax is 1000 (10%)", () => expect(PARAM_BOUNDS.feeBpsMax).toBe(1_000));
  it("deadlineSecondsMax is 86400 (24h)", () => expect(PARAM_BOUNDS.deadlineSecondsMax).toBe(86_400));
  it("fillWindowSecondsMax is 43200 (12h)", () => expect(PARAM_BOUNDS.fillWindowSecondsMax).toBe(43_200));
  it("exposureRatioMax is 1", () => expect(PARAM_BOUNDS.exposureRatioMax).toBe(1));
});
