import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SorobanService } from "./soroban.service";

// ---------------------------------------------------------------------------
// Mock SorobanRpc.Server so no real network calls are made.
// ---------------------------------------------------------------------------

const mockGetHealth = jest.fn();
const mockGetLatestLedger = jest.fn();
const mockGetNetwork = jest.fn();
const mockGetAccount = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk") as object;
  return {
    ...actual,
    SorobanRpc: {
      Server: jest.fn().mockImplementation(() => ({
        getHealth: mockGetHealth,
        getLatestLedger: mockGetLatestLedger,
        getNetwork: mockGetNetwork,
        getAccount: mockGetAccount,
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RPC_URL = "https://soroban-testnet.stellar.org";

function buildConfigService(): ConfigService {
  return {
    get: jest.fn().mockReturnValue(RPC_URL),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SorobanService", () => {
  let service: SorobanService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SorobanService,
        { provide: ConfigService, useValue: buildConfigService() },
      ],
    }).compile();

    service = module.get(SorobanService);
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // getHealth
  // -------------------------------------------------------------------------

  describe("getHealth", () => {
    it("delegates to server.getHealth and returns the result", async () => {
      const mockResult = { status: "healthy" };
      mockGetHealth.mockResolvedValueOnce(mockResult);

      const result = await service.getHealth();

      expect(mockGetHealth).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors thrown by server.getHealth", async () => {
      mockGetHealth.mockRejectedValueOnce(new Error("rpc unavailable"));

      await expect(service.getHealth()).rejects.toThrow("rpc unavailable");
    });
  });

  // -------------------------------------------------------------------------
  // getLatestLedger
  // -------------------------------------------------------------------------

  describe("getLatestLedger", () => {
    it("delegates to server.getLatestLedger and returns the result", async () => {
      const mockResult = { id: "abc123", sequence: 1234567, protocolVersion: 20 };
      mockGetLatestLedger.mockResolvedValueOnce(mockResult);

      const result = await service.getLatestLedger();

      expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors thrown by server.getLatestLedger", async () => {
      mockGetLatestLedger.mockRejectedValueOnce(new Error("ledger fetch failed"));

      await expect(service.getLatestLedger()).rejects.toThrow("ledger fetch failed");
    });
  });

  // -------------------------------------------------------------------------
  // getNetwork
  // -------------------------------------------------------------------------

  describe("getNetwork", () => {
    it("delegates to server.getNetwork and returns the result", async () => {
      const mockResult = { friendbotUrl: "https://friendbot.stellar.org", passphrase: "Test SDF Network ; September 2015" };
      mockGetNetwork.mockResolvedValueOnce(mockResult);

      const result = await service.getNetwork();

      expect(mockGetNetwork).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors thrown by server.getNetwork", async () => {
      mockGetNetwork.mockRejectedValueOnce(new Error("network unavailable"));

      await expect(service.getNetwork()).rejects.toThrow("network unavailable");
    });
  });

  // -------------------------------------------------------------------------
  // getAccount
  // -------------------------------------------------------------------------

  describe("getAccount", () => {
    const PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

    it("delegates to server.getAccount with the given public key", async () => {
      const mockAccount = { id: PUBLIC_KEY, sequence: "12345" };
      mockGetAccount.mockResolvedValueOnce(mockAccount);

      const result = await service.getAccount(PUBLIC_KEY);

      expect(mockGetAccount).toHaveBeenCalledTimes(1);
      expect(mockGetAccount).toHaveBeenCalledWith(PUBLIC_KEY);
      expect(result).toEqual(mockAccount);
    });

    it("propagates errors thrown by server.getAccount", async () => {
      mockGetAccount.mockRejectedValueOnce(new Error("account not found"));

      await expect(service.getAccount(PUBLIC_KEY)).rejects.toThrow("account not found");
    });

    it("passes through different public keys correctly", async () => {
      const anotherKey = "GBVVJJLE2VF7VKUQM7FXKCOQMHJZYJFXBSRH3DPHQHVJQCLJTPB65CG";
      mockGetAccount.mockResolvedValueOnce({ id: anotherKey });

      await service.getAccount(anotherKey);

      expect(mockGetAccount).toHaveBeenCalledWith(anotherKey);
    });
  });
});
