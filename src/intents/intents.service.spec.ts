import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { IntentsService } from "./intents.service";
import { InMemoryIntentsRepository } from "./in-memory-intents.repository";
import { INTENTS_REPOSITORY } from "./intents.repository";

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

describe("IntentsService", () => {
  let service: IntentsService;

  beforeEach(() => {
    service = new IntentsService(fakeConfig(), fakeStellarTxService());
  });

  it("seeds 5 intents on construction", () => {
    expect(service.getAll()).toHaveLength(5);
  });

  it("getAll returns intents sorted by createdAt descending", () => {
    const all = service.getAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }
  });

  it("create adds an open intent with a generated id", async () => {
    const before = service.getAll().length;
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
    expect(service.getAll()).toHaveLength(before + 1);
  });

  it("create defaults deadline to now + 1800 when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const intent = service.create({
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

  it("get returns undefined for an unknown id", () => {
    expect(service.get("does-not-exist")).toBeUndefined();
  });

  it("update mutates and returns the patched intent", () => {
    const [existing] = service.getByState("open");
    const updated = service.update(existing.intentId, { state: "accepted", solver: "SOLVER_X" });

    expect(updated?.state).toBe("accepted");
    expect(updated?.solver).toBe("SOLVER_X");
    expect(service.get(existing.intentId)?.state).toBe("accepted");
  });

  it("update returns null for an unknown id", () => {
    expect(service.update("does-not-exist", { state: "cancelled" })).toBeNull();
  });

  it("getByUser is case-insensitive", () => {
    const [existing] = service.getAll();
    const found = service.getByUser(existing.user.toLowerCase());
    expect(found.some((i) => i.intentId === existing.intentId)).toBe(true);
  });

  it("getByState only returns intents in that state", () => {
    for (const intent of service.getByState("filled")) {
      expect(intent.state).toBe("filled");
    }
  });

  describe("on-chain registration (ONCHAIN_INTENTS_ENABLED)", () => {
    it("stays fully in-memory when the flag is off, never touching StellarTxService", async () => {
      const stellarTxService = fakeStellarTxService();
      const service = new IntentsService(fakeConfig({ onchainIntentsEnabled: false }), stellarTxService);

      const intent = await service.create(validCreateData());

      expect(stellarTxService.invokeContract).not.toHaveBeenCalled();
      expect(service.get(intent.intentId)).toEqual(intent);
    });

    it("invokes the settlement contract and preserves the Intent shape when the flag is on", async () => {
      const stellarTxService = fakeStellarTxService();
      stellarTxService.invokeContract.mockResolvedValue({ hash: "deadbeef", status: "SUCCESS" } as never);
      const service = new IntentsService(
        fakeConfig({ onchainIntentsEnabled: true, settlementContractId: VALID_CONTRACT_ID }),
        stellarTxService,
      );

      const data = validCreateData();
      const intent = await service.create(data);

      expect(stellarTxService.invokeContract).toHaveBeenCalledTimes(1);
      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(VALID_CONTRACT_ID);
      expect(call.method).toBe("create_intent");

      // response shape is unchanged: no fields added/removed relative to the in-memory path
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
      expect(service.get(intent.intentId)).toBeDefined();
    });

    it("rejects with a clear error and does not create the intent when SETTLEMENT_CONTRACT_ID is unset", async () => {
      const stellarTxService = fakeStellarTxService();
      const service = new IntentsService(fakeConfig({ onchainIntentsEnabled: true }), stellarTxService);
      const before = service.getAll().length;

      await expect(service.create(validCreateData())).rejects.toMatchObject({
        message: expect.stringContaining("SETTLEMENT_CONTRACT_ID"),
      });
      expect(stellarTxService.invokeContract).not.toHaveBeenCalled();
      expect(service.getAll()).toHaveLength(before);
    });

    it("rejects and does not create the intent when the on-chain call fails", async () => {
      const stellarTxService = fakeStellarTxService();
      stellarTxService.invokeContract.mockRejectedValue(new Error("submission failed after 5 attempts"));
      const service = new IntentsService(
        fakeConfig({ onchainIntentsEnabled: true, settlementContractId: VALID_CONTRACT_ID }),
        stellarTxService,
      );
      const before = service.getAll().length;

      await expect(service.create(validCreateData())).rejects.toThrow(/settlement contract/i);
      expect(service.getAll()).toHaveLength(before);
    });
  });
});
