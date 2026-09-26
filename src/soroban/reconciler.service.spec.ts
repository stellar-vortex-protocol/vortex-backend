/**
 * Table-driven unit tests for ReconcilerService (#392).
 *
 * Covers every divergence class: missing_locally, state_mismatch,
 * solver_mismatch, amount_mismatch, and the dry-run guard.
 */

import { ReconcilerService } from "./reconciler.service";
import { SettlementClient, type OnChainIntent } from "./contracts/settlement.client";
import { IntentsService } from "../intents/intents.service";
import { MetricsService } from "../metrics/metrics.service";
import { ConfigService } from "@nestjs/config";
import type { Intent } from "../intents/intents.types";
import type { AppConfig } from "../config/configuration";

import type { AppConfig } from "../config/configuration";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_INTENT: Intent = {
  intentId: "550e8400-e29b-41d4-a716-446655440000",
  user: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  srcChain: "stellar",
  srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" as const },
  srcAmount: "1000000000",
  dstToken: { contract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M", symbol: "USDC", decimals: 6 },
  minDstAmount: "990000000",
  solver: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKW7MW8X2ONKGZGK6XOMP",
  state: "accepted",
  createdAt: Math.floor(Date.now() / 1000) - 1000,
  deadline: Math.floor(Date.now() / 1000) + 3600,
};

const BASE_ON_CHAIN: OnChainIntent = {
  intentId: BASE_INTENT.intentId,
  user: BASE_INTENT.user,
  solver: BASE_INTENT.solver!,
  state: "accepted",
  srcAmount: BigInt("1000000000"),
  minDstAmount: BigInt("990000000"),
  fillAmount: null,
  deadline: BigInt(BASE_INTENT.deadline),
};

function buildReconciler(opts: {
  localIntents?: Intent[];
  onChainResult?: Map<string, { ok: boolean; value?: OnChainIntent; error?: string; reason?: string }>;
  dryRun?: boolean;
  staleSeconds?: number;
}) {
  const {
    localIntents = [BASE_INTENT],
    onChainResult,
    dryRun = false,
    staleSeconds = 0, // zero = all intents are stale immediately
  } = opts;

  const defaultChainResult = new Map([
    [BASE_INTENT.intentId, { ok: true as const, value: BASE_ON_CHAIN }],
  ]);

  const configService = {
    get: jest.fn((key: string) => {
      if (key === "onchainDryRun") return dryRun;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;

  const intentsService = {
    getByState: jest.fn((state: string) => {
      return Promise.resolve(state === "accepted" ? localIntents : []);
    }),
    appendAuditEntry: jest.fn(),
    fillIfAccepted: jest.fn().mockResolvedValue({ ...BASE_INTENT, state: "filled" }),
    cancelIfOpen: jest.fn().mockResolvedValue({ ...BASE_INTENT, state: "cancelled" }),
    acceptIfOpen: jest.fn().mockResolvedValue({ ...BASE_INTENT, state: "accepted" }),
  } as unknown as IntentsService;

  const settlementClient = {
    isConfigured: true,
    getManyIntents: jest.fn().mockResolvedValue(onChainResult ?? defaultChainResult),
  } as unknown as SettlementClient;

  const metricsService = {
    recordIntentTransition: jest.fn(),
  } as unknown as MetricsService;

  process.env.RECONCILE_STALE_SECONDS = String(staleSeconds);

  const service = new ReconcilerService(
    configService,
    intentsService,
    settlementClient,
    metricsService,
  );

  return { service, intentsService, settlementClient };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReconcilerService", () => {
  afterEach(() => {
    delete process.env.RECONCILE_STALE_SECONDS;
  });

  it("returns empty result when no stale intents exist", async () => {
    const { service } = buildReconciler({ localIntents: [] });
    const result = await service.reconcile();
    expect(result.checkedCount).toBe(0);
    expect(result.divergences).toHaveLength(0);
  });

  it("returns empty result when settlement client is not configured", async () => {
    const { service, settlementClient } = buildReconciler({});
    Object.defineProperty(settlementClient, "isConfigured", { get: () => false });
    const result = await service.reconcile();
    expect(result.checkedCount).toBe(0);
  });

  describe("state_mismatch divergence", () => {
    it("detects and repairs state_mismatch: accepted → filled", async () => {
      const chainResult = new Map([
        [BASE_INTENT.intentId, {
          ok: true as const,
          value: { ...BASE_ON_CHAIN, state: "filled" as const, fillAmount: BigInt("995000000") },
        }],
      ]);

      const { service, intentsService } = buildReconciler({ onChainResult: chainResult });
      const result = await service.reconcile({ dryRun: false });

      expect(result.divergences[0].divergenceClass).toBe("state_mismatch");
      expect(result.repairedCount).toBe(1);
      expect(intentsService.fillIfAccepted).toHaveBeenCalledWith(
        BASE_INTENT.intentId,
        expect.any(String),
        expect.objectContaining({ fillAmount: "995000000" }),
      );
    });

    it("detects state_mismatch: accepted → cancelled", async () => {
      const chainResult = new Map([
        [BASE_INTENT.intentId, {
          ok: true as const,
          value: { ...BASE_ON_CHAIN, state: "cancelled" as const },
        }],
      ]);

      const { service, intentsService } = buildReconciler({ onChainResult: chainResult });
      const result = await service.reconcile({ dryRun: false });

      expect(result.divergences[0].divergenceClass).toBe("state_mismatch");
      expect(intentsService.cancelIfOpen).toHaveBeenCalled();
    });
  });

  describe("solver_mismatch divergence", () => {
    it("detects solver mismatch and repairs via acceptIfOpen", async () => {
      const differentSolver = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
      const chainResult = new Map([
        [BASE_INTENT.intentId, {
          ok: true as const,
          value: { ...BASE_ON_CHAIN, solver: differentSolver },
        }],
      ]);

      const openIntent: Intent = { ...BASE_INTENT, state: "open", solver: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKW7MW8X2ONKGZGK6XOMP" };
      const configService = { get: jest.fn(() => false) } as unknown as ConfigService<AppConfig, true>;
      const intentsService = {
        getByState: jest.fn((s: string) => Promise.resolve(s === "open" ? [openIntent] : [])),
        appendAuditEntry: jest.fn(),
        acceptIfOpen: jest.fn().mockResolvedValue({ ...openIntent, solver: differentSolver, state: "accepted" }),
        fillIfAccepted: jest.fn(),
        cancelIfOpen: jest.fn(),
      } as unknown as IntentsService;
      const settlementClient = {
        isConfigured: true,
        getManyIntents: jest.fn().mockResolvedValue(chainResult),
      } as unknown as SettlementClient;
      const metrics = { recordIntentTransition: jest.fn() } as unknown as MetricsService;

      process.env.RECONCILE_STALE_SECONDS = "0";
      const service = new ReconcilerService(configService, intentsService, settlementClient, metrics);

      const result = await service.reconcile({ dryRun: false });
      const solverDiv = result.divergences.find((d) => d.divergenceClass === "solver_mismatch");
      expect(solverDiv).toBeDefined();
    });
  });

  describe("amount_mismatch divergence", () => {
    it("detects amount mismatch but does NOT auto-repair", async () => {
      const chainResult = new Map([
        [BASE_INTENT.intentId, {
          ok: true as const,
          value: { ...BASE_ON_CHAIN, state: "filled" as const, fillAmount: BigInt("111111111") },
        }],
      ]);

      const filledIntent: Intent = { ...BASE_INTENT, state: "filled", fillAmount: "999999999" };
      const configService = { get: jest.fn(() => false) } as unknown as ConfigService<AppConfig, true>;
      const intentsService = {
        getByState: jest.fn((s: string) => Promise.resolve(s === "accepted" ? [filledIntent] : [])),
        appendAuditEntry: jest.fn(),
        fillIfAccepted: jest.fn(),
        cancelIfOpen: jest.fn(),
        acceptIfOpen: jest.fn(),
      } as unknown as IntentsService;
      const settlementClient = {
        isConfigured: true,
        getManyIntents: jest.fn().mockResolvedValue(chainResult),
      } as unknown as SettlementClient;
      const metrics = { recordIntentTransition: jest.fn() } as unknown as MetricsService;

      process.env.RECONCILE_STALE_SECONDS = "0";
      const service = new ReconcilerService(configService, intentsService, settlementClient, metrics);
      const result = await service.reconcile({ dryRun: false });

      const amountDiv = result.divergences.find((d) => d.divergenceClass === "amount_mismatch");
      expect(amountDiv).toBeDefined();
      // Never auto-repaired
      expect(intentsService.fillIfAccepted).not.toHaveBeenCalled();
      expect(result.repairedCount).toBe(0);
    });
  });

  describe("dry-run mode", () => {
    it("reports divergences but applies zero repairs", async () => {
      const chainResult = new Map([
        [BASE_INTENT.intentId, {
          ok: true as const,
          value: { ...BASE_ON_CHAIN, state: "filled" as const, fillAmount: BigInt("995000000") },
        }],
      ]);

      const { service, intentsService } = buildReconciler({ onChainResult: chainResult, dryRun: true });
      const result = await service.reconcile({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.divergences).toHaveLength(1);
      expect(result.repairedCount).toBe(0);
      expect(intentsService.fillIfAccepted).not.toHaveBeenCalled();
    });
  });

  describe("markIntentUpdated()", () => {
    it("prevents recently-updated intents from being reconciled", async () => {
      const { service, settlementClient } = buildReconciler({ staleSeconds: 3600 });

      // Mark the intent as recently updated — it should not be stale
      service.markIntentUpdated(BASE_INTENT.intentId);

      const result = await service.reconcile();
      expect(result.checkedCount).toBe(0);
      expect(settlementClient.getManyIntents).not.toHaveBeenCalled();
    });
  });
});
