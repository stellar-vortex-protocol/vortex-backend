import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { IntentsService } from "./intents.service";
import { PrismaService } from "../prisma/prisma.service";

const VALID_CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function fakeConfig(overrides: { onchainIntentsEnabled?: boolean; settlementContractId?: string } = {}) {
  const values: Record<string, unknown> = {
    onchainIntentsEnabled: overrides.onchainIntentsEnabled ?? false,
    "stellar.settlementContractId": overrides.settlementContractId ?? "",
  };
  return { get: (path: string) => values[path] } as ConfigService<AppConfig, true>;
}

function fakeStellarTxService() {
  return { invokeContract: jest.fn() } as unknown as jest.Mocked<StellarTxService>;
}

function fakePrismaService(): PrismaService {
  return {
    intentAuditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

function makeService(
  configOverrides: { onchainIntentsEnabled?: boolean; settlementContractId?: string } = {},
  stellarTx?: jest.Mocked<StellarTxService>,
) {
  return new IntentsService(
    fakeConfig(configOverrides),
    stellarTx ?? fakeStellarTxService(),
    fakePrismaService(),
  );
}

function validCreateData() {
  return {
    user: Keypair.random().publicKey(),
    srcChain: "ethereum" as const,
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" as const },
    srcAmount: "1000000",
    dstToken: { contract: VALID_CONTRACT_ID, symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    deadline: Math.floor(Date.now() / 1000) + 1800,
  };
}

async function buildService(
  configOverrides: { onchainIntentsEnabled?: boolean; settlementContractId?: string } = {},
  stellarTxService?: jest.Mocked<StellarTxService>,
): Promise<IntentsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      {
        provide: INTENTS_REPOSITORY,
        useClass: InMemoryIntentsRepository,
      },
      {
        provide: ConfigService,
        useValue: fakeConfig(configOverrides),
      },
      {
        provide: StellarTxService,
        useValue: stellarTxService ?? fakeStellarTxService(),
      },
      IntentsService,
    ],
  }).compile();

  return module.get<IntentsService>(IntentsService);
}

describe("IntentsService", () => {
  let service: IntentsService;

  beforeEach(() => {
    service = makeService();
  });

  it("seeds 5 intents on construction", async () => {
    expect(await service.getAll()).toHaveLength(5);
  });

  it("getAll returns intents sorted by createdAt descending", async () => {
    const all = await service.getAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }
  });

  it("create adds an open intent with a generated id", async () => {
    const before = (await service.getAll()).length;
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const intent = await service.create({
      user: "GTEST...0000",
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline,
    });

    expect(intent.state).toBe("open");
    expect(intent.intentId).toBeTruthy();
    expect(intent.deadline).toBe(deadline);
    expect(await service.getAll()).toHaveLength(before + 1);
  });

  it("create defaults deadline to now + 1800 when omitted", async () => {
    const before = Math.floor(Date.now() / 1000);
    const intent = await service.create({
      user: "GTEST...0000",
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: undefined as unknown as number,
    });

    expect(intent.deadline).toBeGreaterThanOrEqual(before + 1800);
  });

  it("get returns undefined for an unknown id", async () => {
    expect(await service.get("does-not-exist")).toBeUndefined();
  });

  it("update mutates and returns the patched intent", async () => {
    const [existing] = await service.getByState("open");
    const updated = await service.update(existing.intentId, { state: "accepted", solver: "SOLVER_X" });

    expect(updated?.state).toBe("accepted");
    expect(updated?.solver).toBe("SOLVER_X");
    expect((await service.get(existing.intentId))?.state).toBe("accepted");
  });

  it("update returns null for an unknown id", async () => {
    expect(await service.update("does-not-exist", { state: "cancelled" })).toBeNull();
  });

  it("getByUser is case-insensitive", async () => {
    const [existing] = await service.getAll();
    const found = await service.getByUser(existing.user.toLowerCase());
    expect(found.some((i) => i.intentId === existing.intentId)).toBe(true);
  });

  it("getByState only returns intents in that state", async () => {
    for (const intent of await service.getByState("filled")) {
      expect(intent.state).toBe("filled");
    }
  });

  describe("acceptIfOpen", () => {
    it("transitions an open intent to accepted and returns it", async () => {
      const [open] = await service.getByState("open");
      const result = await service.acceptIfOpen(open.intentId, "SOLVER_X");

      expect(result).not.toBeNull();
      expect(result!.state).toBe("accepted");
      expect(result!.solver).toBe("SOLVER_X");
      expect((await service.get(open.intentId))!.state).toBe("accepted");
    });

    it("returns null for a non-existent intent", async () => {
      expect(await service.acceptIfOpen("does-not-exist", "SOLVER_X")).toBeNull();
    });

    it("returns null when the intent is already accepted", async () => {
      const [accepted] = await service.getByState("accepted");
      expect(await service.acceptIfOpen(accepted.intentId, "SOLVER_X")).toBeNull();
    });

    it("only the first caller wins under simulated concurrency", async () => {
      const [open] = await service.getByState("open");
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          service.acceptIfOpen(open.intentId, `SOLVER_${i}`),
        ),
      );

      const successes = results.filter((r) => r !== null);
      expect(successes).toHaveLength(1);
      expect(successes[0]!.state).toBe("accepted");
    });
  });

  describe("fillIfAccepted", () => {
    it("transitions an accepted intent to filled when solver matches", async () => {
      const [accepted] = await service.getByState("accepted");
      const result = await service.fillIfAccepted(accepted.intentId, accepted.solver!, {
        fillAmount: "100",
        txHash: "test-hash",
        filledAt: Math.floor(Date.now() / 1000),
      });

      expect(result).not.toBeNull();
      expect(result!.state).toBe("filled");
      expect(result!.fillAmount).toBe("100");
    });

    it("returns null when solver does not match", async () => {
      const [accepted] = await service.getByState("accepted");
      const result = await service.fillIfAccepted(accepted.intentId, "WRONG_SOLVER", {
        fillAmount: "100",
      });
      expect(result).toBeNull();
    });

    it("returns null for a non-existent intent", async () => {
      expect(await service.fillIfAccepted("nope", "SOLVER_X", {})).toBeNull();
    });

    it("only the first caller wins under simulated concurrency", async () => {
      const [accepted] = await service.getByState("accepted");
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          service.fillIfAccepted(accepted.intentId, accepted.solver!, {
            fillAmount: "100",
            txHash: "race-hash",
            filledAt: Math.floor(Date.now() / 1000),
          }),
        ),
      );

      const successes = results.filter((r) => r !== null);
      expect(successes).toHaveLength(1);
      expect(successes[0]!.state).toBe("filled");
    });
  });

  describe("on-chain registration (ONCHAIN_INTENTS_ENABLED)", () => {
    it("stays fully in the repository when the flag is off, never touching StellarTxService", async () => {
      const stellarTxService = fakeStellarTxService();
      const service = makeService({ onchainIntentsEnabled: false }, stellarTxService);

      const intent = await svc.create(validCreateData());

      expect(stellarTxService.invokeContract).not.toHaveBeenCalled();
      expect(await svc.get(intent.intentId)).toEqual(intent);
    });

    it("invokes the settlement contract and preserves the Intent shape when the flag is on", async () => {
      const stellarTxService = fakeStellarTxService();
      stellarTxService.invokeContract.mockResolvedValue({ hash: "deadbeef", status: "SUCCESS" } as never);
      const service = makeService(
        { onchainIntentsEnabled: true, settlementContractId: VALID_CONTRACT_ID },
        stellarTxService,
      );

      const data = validCreateData();
      const intent = await svc.create(data);

      expect(stellarTxService.invokeContract).toHaveBeenCalledTimes(1);
      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(VALID_CONTRACT_ID);
      expect(call.method).toBe("create_intent");

      // response shape is unchanged relative to the in-memory path
      expect(Object.keys(intent).sort()).toEqual(
        Object.keys({
          intentId: "",
          user: "",
          srcChain: "",
          srcToken: "",
          srcAmount: "",
          dstToken: "",
          minDstAmount: "",
          state: "",
          createdAt: 0,
          deadline: 0,
        }).sort(),
      );
      expect(await svc.get(intent.intentId)).toBeDefined();
    });

    it("rejects with a clear error and does not create the intent when SETTLEMENT_CONTRACT_ID is unset", async () => {
      const stellarTxService = fakeStellarTxService();
      const service = makeService({ onchainIntentsEnabled: true }, stellarTxService);
      const before = service.getAll().length;

      await expect(svc.create(validCreateData())).rejects.toMatchObject({
        message: expect.stringContaining("SETTLEMENT_CONTRACT_ID"),
      });
      expect(stellarTxService.invokeContract).not.toHaveBeenCalled();
      expect(await svc.getAll()).toHaveLength(before);
    });

    it("rejects and does not create the intent when the on-chain call fails", async () => {
      const stellarTxService = fakeStellarTxService();
      stellarTxService.invokeContract.mockRejectedValue(new Error("submission failed after 5 attempts"));
      const service = makeService(
        { onchainIntentsEnabled: true, settlementContractId: VALID_CONTRACT_ID },
        stellarTxService,
      );
      const before = (await svc.getAll()).length;

      await expect(svc.create(validCreateData())).rejects.toThrow(/settlement contract/i);
      expect(await svc.getAll()).toHaveLength(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Audit trail (issue #217 / #62)
  // ---------------------------------------------------------------------------

  describe("appendAuditEntry / getAuditLog", () => {
    it("returns an empty array for an intent with no audit entries", () => {
      expect(service.getAuditLog("no-such-intent")).toEqual([]);
    });

    it("appends a single entry and getAuditLog returns it", () => {
      service.appendAuditEntry("intent-1", "cancelled", "USER_ADDR", "user cancelled");
      const log = service.getAuditLog("intent-1");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        toState: "cancelled",
        actor: "USER_ADDR",
        reason: "user cancelled",
      });
      expect(log[0].timestamp).toBeTruthy(); // ISO timestamp
    });

    it("appends multiple entries in order and getAuditLog returns oldest-first", async () => {
      service.appendAuditEntry("intent-2", "accepted", "SOLVER_A", "solver accepted");
      await new Promise((r) => setTimeout(r, 5)); // small gap so timestamps differ
      service.appendAuditEntry("intent-2", "filled", "SOLVER_A", "solver filled");

      const log = service.getAuditLog("intent-2");
      expect(log).toHaveLength(2);
      expect(log[0].toState).toBe("accepted");
      expect(log[1].toState).toBe("filled");
    });

    it("stores optional metadata in the entry", () => {
      service.appendAuditEntry("intent-3", "expired", "system", "deadline passed", {
        deadline: 1234567890,
        sweepedAt: 1234567900,
      });
      const log = service.getAuditLog("intent-3");
      expect(log[0].metadata).toEqual({ deadline: 1234567890, sweepedAt: 1234567900 });
    });

    it("does not mix entries across different intentIds", () => {
      service.appendAuditEntry("intent-A", "cancelled", "USER_A", "cancel A");
      service.appendAuditEntry("intent-B", "expired", "system", "expire B");

      expect(service.getAuditLog("intent-A")).toHaveLength(1);
      expect(service.getAuditLog("intent-B")).toHaveLength(1);
      expect(service.getAuditLog("intent-A")[0].toState).toBe("cancelled");
      expect(service.getAuditLog("intent-B")[0].toState).toBe("expired");
    });

    it("fires a DB write via PrismaService on each append (non-blocking)", async () => {
      const prismaService = {
        intentAuditLog: {
          create: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as unknown as PrismaService;
      const svc = new IntentsService(fakeConfig(), fakeStellarTxService(), prismaService);

      svc.appendAuditEntry("intent-db", "slashed", "system", "missed fill", { foo: "bar" });

      // The DB write is fire-and-forget — wait one tick for the promise chain
      await new Promise((r) => setImmediate(r));

      const mockPrisma = prismaService as unknown as {
        intentAuditLog: { create: jest.Mock };
      };
      expect(mockPrisma.intentAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            intentId: "intent-db",
            toState: "slashed",
            actor: "system",
            reason: "missed fill",
          }),
        }),
      );
    });

    it("does NOT throw when the DB write fails — logs an error but returns normally", async () => {
      const prismaService = {
        intentAuditLog: {
          create: jest.fn().mockRejectedValue(new Error("DB is down")),
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as unknown as PrismaService;
      const svc = new IntentsService(fakeConfig(), fakeStellarTxService(), prismaService);

      // Should not throw synchronously
      expect(() =>
        svc.appendAuditEntry("intent-fail", "expired", "system", "deadline"),
      ).not.toThrow();

      // In-memory log still has the entry
      expect(svc.getAuditLog("intent-fail")).toHaveLength(1);

      // Wait for the rejected promise — should not propagate
      await new Promise((r) => setImmediate(r));
      // No unhandled rejection here (jest would fail the test if one occurred)
    });
  });
});
