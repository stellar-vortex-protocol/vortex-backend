import { Test, TestingModule } from "@nestjs/testing";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";

// ---------------------------------------------------------------------------
// Mock SorobanService — we only want to verify the controller wires correctly.
// ---------------------------------------------------------------------------

const mockSorobanService = {
  getHealth: jest.fn(),
  getLatestLedger: jest.fn(),
  getNetwork: jest.fn(),
  getAccount: jest.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SorobanController", () => {
  let controller: SorobanController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SorobanController],
      providers: [{ provide: SorobanService, useValue: mockSorobanService }],
    }).compile();

    controller = module.get(SorobanController);
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // getHealth
  // -------------------------------------------------------------------------

  // The pre-existing test references `getHealth` which was renamed `getChainHealth`.
  // Patch the mock and the calls to use the new method name.
  describe("getChainHealth", () => {
    it("calls sorobanService.getEndpointHealthReport and returns endpoints", async () => {
      const mockEndpoints = [{ url: "https://rpc.example.com", state: "closed", score: 1, errorRate: 0, p95LatencyMs: 0, ledgerLag: 0, lastSuccessAt: null, lastErrorAt: null, consecutiveErrors: 0 }];
      const svc = controller["sorobanService"] as unknown as { getEndpointHealthReport: jest.Mock };
      svc.getEndpointHealthReport = jest.fn().mockReturnValue(mockEndpoints);

      const result = controller.getChainHealth();
      expect(result).toEqual({ endpoints: mockEndpoints });
    });

    it("propagates errors from sorobanService.getEndpointHealthReport", () => {
      const svc = controller["sorobanService"] as unknown as { getEndpointHealthReport: jest.Mock };
      svc.getEndpointHealthReport = jest.fn().mockImplementation(() => { throw new Error("rpc down"); });
      expect(() => controller.getChainHealth()).toThrow("rpc down");
    });
  });

  // -------------------------------------------------------------------------
  // getLatestLedger
  // -------------------------------------------------------------------------

  describe("getLatestLedger", () => {
    it("calls sorobanService.getLatestLedger and returns its result", async () => {
      const mockResult = { id: "ledgerhash", sequence: 9999 };
      mockSorobanService.getLatestLedger.mockResolvedValueOnce(mockResult);

      const result = await controller.getLatestLedger();

      expect(mockSorobanService.getLatestLedger).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors from sorobanService.getLatestLedger", async () => {
      mockSorobanService.getLatestLedger.mockRejectedValueOnce(new Error("ledger unavailable"));

      await expect(controller.getLatestLedger()).rejects.toThrow("ledger unavailable");
    });
  });

  // -------------------------------------------------------------------------
  // getNetwork
  // -------------------------------------------------------------------------

  describe("getNetwork", () => {
    it("calls sorobanService.getNetwork and returns its result", async () => {
      const mockResult = { passphrase: "Test SDF Network ; September 2015" };
      mockSorobanService.getNetwork.mockResolvedValueOnce(mockResult);

      const result = await controller.getNetwork();

      expect(mockSorobanService.getNetwork).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors from sorobanService.getNetwork", async () => {
      mockSorobanService.getNetwork.mockRejectedValueOnce(new Error("network unreachable"));

      await expect(controller.getNetwork()).rejects.toThrow("network unreachable");
    });
  });

  // -------------------------------------------------------------------------
  // getAccount
  // -------------------------------------------------------------------------

  describe("getAccount", () => {
    const PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

    it("passes the publicKey path param through to sorobanService.getAccount", async () => {
      const mockAccount = { id: PUBLIC_KEY, sequence: "98765" };
      mockSorobanService.getAccount.mockResolvedValueOnce(mockAccount);

      const result = await controller.getAccount(PUBLIC_KEY);

      expect(mockSorobanService.getAccount).toHaveBeenCalledTimes(1);
      expect(mockSorobanService.getAccount).toHaveBeenCalledWith(PUBLIC_KEY);
      expect(result).toEqual(mockAccount);
    });

    it("passes a different publicKey correctly", async () => {
      const anotherKey = "GBVVJJLE2VF7VKUQM7FXKCOQMHJZYJFXBSRH3DPHQHVJQCLJTPB65CG";
      mockSorobanService.getAccount.mockResolvedValueOnce({ id: anotherKey });

      await controller.getAccount(anotherKey);

      expect(mockSorobanService.getAccount).toHaveBeenCalledWith(anotherKey);
    });

    it("propagates errors from sorobanService.getAccount", async () => {
      mockSorobanService.getAccount.mockRejectedValueOnce(new Error("account not found"));

      await expect(controller.getAccount(PUBLIC_KEY)).rejects.toThrow("account not found");
    });
  });
});
