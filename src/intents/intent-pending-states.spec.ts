/**
 * Issue #385 — Submitted-vs-Confirmed Intent Lifecycle with Pending On-Chain States.
 *
 * Tests covering:
 *   1. Creating an intent with onchain enabled results in `pending_open` state
 *   2. Confirming a pending_open intent transitions it to `open`
 *   3. transitionToOnChainPending maps op → correct pending state
 *   4. The in-memory (non-onchain) path still uses `open` directly (no regression)
 *   5. accept/fill/cancel yield pending_* states when onchain is enabled
 *   6. TERMINAL_STATES does not include any pending_ state (eviction safety)
 *   7. countOpenByUser counts pending_open and pending_accepted as active
 */

import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IIntentsRepository, InMemoryIntentsRepository } from "./intents.repository";
import { Intent, IntentState, INTENT_STATES } from "./intents.types";
import { AppConfig } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";

// ── helpers ────────────────────────────────────────────────────────────────

const VALID_CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const VALID_USER = "GDHQEMUAOOQIMKMZNQNTHXZQBBMMDTAMOUE7IXYWJF4BQTLUMKEXWTIP";
const VALID_SOLVER = "GDTESTSOLVERADDR0000000000000000000000000000000000000000000";

function fakeConfig(overrides: {
  onchainIntentsEnabled?: boolean;
  settlementContractId?: string;
} = {}) {
  const values: Record<string, unknown> = {
    onchainIntentsEnabled: overrides.onchainIntentsEnabled ?? false,
    "stellar.settlementContractId": overrides.settlementContractId ?? VALID_CONTRACT_ID,
    intentRetentionDays: 30,
    intentRetentionSweepMs: 60_000,
  };
  return { get: (path: string) => values[path] } as ConfigService<AppConfig, true>;
}

function fakePrisma(): PrismaService {
  return {
    intentAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function fakeStellarTx(hash = "TXHASH_FAKE"): jest.Mocked<StellarTxService> {
  return {
    invokeContract: jest.fn().mockResolvedValue({ hash }),
  } as unknown as jest.Mocked<StellarTxService>;
}

function makeService(
  opts: {
    onchainIntentsEnabled?: boolean;
    settlementContractId?: string;
    stellarTx?: jest.Mocked<StellarTxService>;
    repo?: IIntentsRepository;
  } = {},
): IntentsService {
  const repo = opts.repo ?? new InMemoryIntentsRepository();
  const config = fakeConfig({
    onchainIntentsEnabled: opts.onchainIntentsEnabled,
    settlementContractId: opts.settlementContractId,
  });
  const stellarTx = opts.stellarTx ?? fakeStellarTx();
  const prisma = fakePrisma();
  return new IntentsService(repo, config, stellarTx, prisma);
}

function validCreateData(): Omit<Intent, "intentId" | "createdAt" | "state"> {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: VALID_USER,
    srcChain: "ethereum",
    srcToken: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      chain: "ethereum",
    },
    srcAmount: "1000000",
    dstToken: {
      contract: VALID_CONTRACT_ID,
      symbol: "USDC",
      decimals: 7,
    },
    minDstAmount: "990000",
    deadline: now + 1800,
  };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe("Issue #385 — pending on-chain intent states", () => {
  afterEach(() => jest.restoreAllMocks());

  // ── 1. INTENT_STATES tuple ──────────────────────────────────────────────

  describe("INTENT_STATES tuple", () => {
    it("includes all four pending_ variants", () => {
      const pendingStates: IntentState[] = [
        "pending_open",
        "pending_accepted",
        "pending_filled",
        "pending_cancelled",
      ];
      for (const s of pendingStates) {
        expect(INTENT_STATES).toContain(s);
      }
    });

    it("still includes all original states", () => {
      const originalStates: IntentState[] = [
        "open",
        "accepted",
        "filled",
        "cancelled",
        "expired",
        "slashed",
      ];
      for (const s of originalStates) {
        expect(INTENT_STATES).toContain(s);
      }
    });

    it("has 10 total states", () => {
      expect(INTENT_STATES).toHaveLength(10);
    });
  });

  // ── 2. Non-onchain path unchanged ───────────────────────────────────────

  describe("in-memory (non-onchain) path", () => {
    let service: IntentsService;

    beforeEach(() => {
      service = makeService({ onchainIntentsEnabled: false });
    });

    afterEach(() => service.onModuleDestroy());

    it("create() returns state=open directly (no pending state)", async () => {
      const intent = await service.create(validCreateData());
      expect(intent.state).toBe("open");
      expect(intent.pendingTxHash).toBeUndefined();
      expect(intent.pendingOp).toBeUndefined();
    });

    it("acceptIfOpen() transitions open→accepted (no pending)", async () => {
      const intent = await service.create(validCreateData());
      const accepted = await service.acceptIfOpen(intent.intentId, VALID_SOLVER);
      expect(accepted?.state).toBe("accepted");
    });

    it("fillIfAccepted() transitions accepted→filled (no pending)", async () => {
      const intent = await service.create(validCreateData());
      await service.acceptIfOpen(intent.intentId, VALID_SOLVER);
      const now = Math.floor(Date.now() / 1000);
      const filled = await service.fillIfAccepted(intent.intentId, VALID_SOLVER, {
        filledAt: now,
        fillAmount: "990000",
        feeAmount: "495",
        txHash: "TX_FILL",
      });
      expect(filled?.state).toBe("filled");
    });

    it("cancelIfOpen() transitions open→cancelled (no pending)", async () => {
      const intent = await service.create(validCreateData());
      const cancelled = await service.cancelIfOpen(intent.intentId);
      expect(cancelled?.state).toBe("cancelled");
    });
  });

  // ── 3. Onchain path — create → pending_open ─────────────────────────────

  describe("onchain path — create", () => {
    it("create() returns state=pending_open when onchain is enabled", async () => {
      const tx = fakeStellarTx("TX_CREATE_HASH");
      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx });

      // Bypass buildCreateIntentArgs (which calls new Address() and validates the format)
      // by mocking the private registerOnChain method directly.
      jest
        .spyOn(service as unknown as { registerOnChain: () => Promise<string> }, "registerOnChain")
        .mockResolvedValue("TX_CREATE_HASH");

      const intent = await service.create(validCreateData());

      expect(intent.state).toBe("pending_open");
      expect(intent.pendingOp).toBe("create");

      service.onModuleDestroy();
    });

    it("create() attaches pendingTxHash returned by stellarTxService", async () => {
      const tx = fakeStellarTx("TX_HASH_FROM_CHAIN");
      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx });

      jest
        .spyOn(service as unknown as { registerOnChain: () => Promise<string> }, "registerOnChain")
        .mockResolvedValue("TX_HASH_FROM_CHAIN");

      const intent = await service.create(validCreateData());

      expect(intent.pendingTxHash).toBe("TX_HASH_FROM_CHAIN");

      service.onModuleDestroy();
    });

    it("create() cleans up the pending_open record when on-chain registration fails", async () => {
      const tx = {
        invokeContract: jest.fn().mockRejectedValue(new Error("network error")),
      } as unknown as jest.Mocked<StellarTxService>;
      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx });

      jest
        .spyOn(service as unknown as { registerOnChain: () => Promise<string> }, "registerOnChain")
        .mockRejectedValue(new ServiceUnavailableException("Failed to register intent with the settlement contract"));

      await expect(service.create(validCreateData())).rejects.toThrow(
        ServiceUnavailableException,
      );
      // After failure, the repo should have only the seeded intents (no dangling pending_open)
      const all = await service.getAll();
      expect(all.every((i) => i.state !== "pending_open")).toBe(true);

      service.onModuleDestroy();
    });
  });

  // ── 4. confirmIntent — pending_open → open ──────────────────────────────

  describe("confirmIntent()", () => {
    it("transitions pending_open → open and clears pendingTxHash/pendingOp", async () => {
      const tx = fakeStellarTx();
      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx });

      jest
        .spyOn(service as unknown as { registerOnChain: () => Promise<string> }, "registerOnChain")
        .mockResolvedValue("TX_CONFIRM_TEST");

      const intent = await service.create(validCreateData());
      expect(intent.state).toBe("pending_open");

      const confirmed = await service.confirmIntent(intent.intentId);

      expect(confirmed?.state).toBe("open");
      expect(confirmed?.pendingTxHash).toBeUndefined();
      expect(confirmed?.pendingOp).toBeUndefined();

      service.onModuleDestroy();
    });

    it("returns null for an intent not in a pending state", async () => {
      const service = makeService({ onchainIntentsEnabled: false });

      const intent = await service.create(validCreateData()); // state = open
      const result = await service.confirmIntent(intent.intentId);

      expect(result).toBeNull();

      service.onModuleDestroy();
    });

    it("returns null for a non-existent intent", async () => {
      const service = makeService();
      const result = await service.confirmIntent("does-not-exist");
      expect(result).toBeNull();
      service.onModuleDestroy();
    });

    it("transitions pending_accepted → accepted", async () => {
      const service = makeService({ onchainIntentsEnabled: false });

      // Manually craft a pending_accepted intent via transitionToOnChainPending
      const intent = await service.create(validCreateData());
      await service.acceptIfOpen(intent.intentId, VALID_SOLVER);
      await service.transitionToOnChainPending(intent.intentId, "accept", "TX_ACC");

      const confirmed = await service.confirmIntent(intent.intentId);
      expect(confirmed?.state).toBe("accepted");
      expect(confirmed?.pendingTxHash).toBeUndefined();

      service.onModuleDestroy();
    });

    it("transitions pending_filled → filled", async () => {
      const service = makeService({ onchainIntentsEnabled: false });
      const now = Math.floor(Date.now() / 1000);

      const intent = await service.create(validCreateData());
      await service.acceptIfOpen(intent.intentId, VALID_SOLVER);
      await service.fillIfAccepted(intent.intentId, VALID_SOLVER, {
        filledAt: now,
        fillAmount: "990000",
        feeAmount: "495",
        txHash: "TX_FILL",
      });
      await service.transitionToOnChainPending(intent.intentId, "fill", "TX_FILL_PENDING");

      const confirmed = await service.confirmIntent(intent.intentId);
      expect(confirmed?.state).toBe("filled");

      service.onModuleDestroy();
    });

    it("transitions pending_cancelled → cancelled", async () => {
      const service = makeService({ onchainIntentsEnabled: false });

      const intent = await service.create(validCreateData());
      await service.cancelIfOpen(intent.intentId);
      await service.transitionToOnChainPending(intent.intentId, "cancel", "TX_CANCEL");

      const confirmed = await service.confirmIntent(intent.intentId);
      expect(confirmed?.state).toBe("cancelled");

      service.onModuleDestroy();
    });
  });

  // ── 5. transitionToOnChainPending ───────────────────────────────────────

  describe("transitionToOnChainPending()", () => {
    it.each([
      ["create", "pending_open"],
      ["accept", "pending_accepted"],
      ["fill", "pending_filled"],
      ["cancel", "pending_cancelled"],
    ] as const)(
      "op=%s → state=%s",
      async (op, expectedState) => {
        const service = makeService({ onchainIntentsEnabled: false });
        const intent = await service.create(validCreateData());

        // Put the intent in the right base state for the operation
        if (op === "accept" || op === "fill" || op === "cancel") {
          await service.acceptIfOpen(intent.intentId, VALID_SOLVER);
        }
        if (op === "fill") {
          const now = Math.floor(Date.now() / 1000);
          await service.fillIfAccepted(intent.intentId, VALID_SOLVER, {
            filledAt: now,
            fillAmount: "990000",
            feeAmount: "495",
          });
        }
        if (op === "cancel") {
          // Reset to open by going through a fresh intent
        }

        const updated = await service.transitionToOnChainPending(
          intent.intentId,
          op,
          "FAKE_TX",
        );

        expect(updated?.state).toBe(expectedState);
        expect(updated?.pendingOp).toBe(op);
        expect(updated?.pendingTxHash).toBe("FAKE_TX");

        service.onModuleDestroy();
      },
    );

    it("returns null for a non-existent intentId", async () => {
      const service = makeService();
      const result = await service.transitionToOnChainPending("no-such-id", "create");
      expect(result).toBeNull();
      service.onModuleDestroy();
    });
  });

  // ── 6. onchain path — accept/fill/cancel yield pending_ states ──────────

  describe("onchain path — accept/fill/cancel", () => {
    it("acceptIfOpen() → pending_accepted when onchain is enabled", async () => {
      const tx = fakeStellarTx();
      const offchainService = makeService({ onchainIntentsEnabled: false });
      const intent = await offchainService.create(validCreateData());
      offchainService.onModuleDestroy();

      // Build a fresh service backed by the same repo (already has the open intent)
      // We need to inject that specific intent, so use a shared repo
      const repo = new InMemoryIntentsRepository();
      // Save the intent into the new repo
      await repo.save({ ...intent, state: "open" });

      const onchainService = makeService({
        onchainIntentsEnabled: true,
        stellarTx: tx,
        repo,
      });

      const accepted = await onchainService.acceptIfOpen(intent.intentId, VALID_SOLVER);
      expect(accepted?.state).toBe("pending_accepted");
      expect(accepted?.pendingOp).toBe("accept");

      onchainService.onModuleDestroy();
    });

    it("fillIfAccepted() → pending_filled when onchain is enabled", async () => {
      const tx = fakeStellarTx();
      const now = Math.floor(Date.now() / 1000);

      const repo = new InMemoryIntentsRepository();
      const data = validCreateData();
      // Put an accepted intent directly in the repo
      const acceptedIntent: Intent = {
        ...data,
        intentId: "fill-pending-test",
        state: "accepted",
        createdAt: now,
        solver: VALID_SOLVER,
      };
      await repo.save(acceptedIntent);

      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx, repo });

      const filled = await service.fillIfAccepted("fill-pending-test", VALID_SOLVER, {
        filledAt: now,
        fillAmount: "990000",
        feeAmount: "495",
      });
      expect(filled?.state).toBe("pending_filled");
      expect(filled?.pendingOp).toBe("fill");

      service.onModuleDestroy();
    });

    it("cancelIfOpen() → pending_cancelled when onchain is enabled", async () => {
      const tx = fakeStellarTx();
      const now = Math.floor(Date.now() / 1000);

      const repo = new InMemoryIntentsRepository();
      const data = validCreateData();
      const openIntent: Intent = {
        ...data,
        intentId: "cancel-pending-test",
        state: "open",
        createdAt: now,
      };
      await repo.save(openIntent);

      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx, repo });

      const cancelled = await service.cancelIfOpen("cancel-pending-test");
      expect(cancelled?.state).toBe("pending_cancelled");
      expect(cancelled?.pendingOp).toBe("cancel");

      service.onModuleDestroy();
    });
  });

  // ── 7. TERMINAL_STATES excludes pending_ ────────────────────────────────

  describe("terminal-state eviction safety", () => {
    it("pending_open is not a terminal state (not evicted)", async () => {
      const tx = fakeStellarTx();
      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx });

      jest
        .spyOn(service as unknown as { registerOnChain: () => Promise<string> }, "registerOnChain")
        .mockResolvedValue("TX_EVICTION_TEST");

      const intent = await service.create(validCreateData());
      expect(intent.state).toBe("pending_open");

      // logStoreSize triggers eviction; a pending_open intent must survive
      await service.logStoreSize();

      const found = await service.get(intent.intentId);
      expect(found).toBeDefined();
      expect(found?.state).toBe("pending_open");

      service.onModuleDestroy();
    });
  });

  // ── 8. countOpenByUser includes pending states ───────────────────────────

  describe("countOpenByUser", () => {
    it("counts pending_open intents as active", async () => {
      const tx = fakeStellarTx();
      const service = makeService({ onchainIntentsEnabled: true, stellarTx: tx });

      jest
        .spyOn(service as unknown as { registerOnChain: () => Promise<string> }, "registerOnChain")
        .mockResolvedValue("TX_COUNT_TEST");

      const data = validCreateData();
      const intent = await service.create(data); // → pending_open
      expect(intent.state).toBe("pending_open");

      const count = await service.countOpenByUser(VALID_USER);
      // Should include the pending_open intent
      expect(count).toBeGreaterThanOrEqual(1);

      service.onModuleDestroy();
    });

    it("counts open and accepted intents as active (non-onchain path)", async () => {
      const service = makeService({ onchainIntentsEnabled: false });

      const data = validCreateData();
      const _intent = await service.create(data); // → open
      const count = await service.countOpenByUser(VALID_USER);
      expect(count).toBeGreaterThanOrEqual(1);

      service.onModuleDestroy();
    });
  });

  // ── 9. Intent interface — pendingTxHash and pendingOp fields ────────────

  describe("Intent interface", () => {
    it("Intent can carry pendingTxHash and pendingOp without type errors", () => {
      const now = Math.floor(Date.now() / 1000);
      const intent: Intent = {
        intentId: "test-id",
        user: VALID_USER,
        srcChain: "ethereum",
        srcToken: {
          address: "0xabc",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          chain: "ethereum",
        },
        srcAmount: "1000000",
        dstToken: { contract: VALID_CONTRACT_ID, symbol: "USDC", decimals: 7 },
        minDstAmount: "990000",
        state: "pending_open",
        createdAt: now,
        deadline: now + 1800,
        pendingTxHash: "TXHASH_TEST",
        pendingOp: "create",
      };

      expect(intent.state).toBe("pending_open");
      expect(intent.pendingTxHash).toBe("TXHASH_TEST");
      expect(intent.pendingOp).toBe("create");
    });

    it("pendingTxHash and pendingOp are optional", () => {
      const now = Math.floor(Date.now() / 1000);
      // This should compile and run without issues
      const intent: Intent = {
        intentId: "test-id-2",
        user: VALID_USER,
        srcChain: "ethereum",
        srcToken: {
          address: "0xabc",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          chain: "ethereum",
        },
        srcAmount: "1000000",
        dstToken: { contract: VALID_CONTRACT_ID, symbol: "USDC", decimals: 7 },
        minDstAmount: "990000",
        state: "open",
        createdAt: now,
        deadline: now + 1800,
      };

      expect(intent.pendingTxHash).toBeUndefined();
      expect(intent.pendingOp).toBeUndefined();
    });
  });
});
