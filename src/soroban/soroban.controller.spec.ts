import { BadRequestException } from "@nestjs/common";
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
    // `reset`, not `clear`: `mockResolvedValueOnce` queues survive
    // `clearAllMocks`, so a leftover one-shot from the previous test would be
    // served before the rejection this test installs.
    // `resetAllMocks`, not `clearAllMocks`: `clearAllMocks` only drops recorded
    // calls and leaves queued `mockResolvedValueOnce` / `mockRejectedValueOnce`
    // implementations in place, so a leftover value from an earlier test is
    // served ahead of the one the current test queued.
    jest.resetAllMocks();

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

  describe("getHealth", () => {
    it("calls sorobanService.getHealth and returns its result", async () => {
      const mockResult = { status: "healthy" };
      mockSorobanService.getHealth.mockResolvedValueOnce(mockResult);

      const result = await controller.getHealth();

      expect(mockSorobanService.getHealth).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors from sorobanService.getHealth", async () => {
      mockSorobanService.getHealth.mockRejectedValueOnce(new Error("rpc down"));

      await expect(controller.getHealth()).rejects.toThrow("rpc down");
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
    // Real strkeys (valid CRC16). A well-formed-looking "G…" string with a bad
    // checksum is rejected by the controller, so fixtures must be genuine.
    const PUBLIC_KEY = "GAMS2CGT4CPVYB5LSZV3FAOYFJK67574RS5HASJNTNS7WEUO3CN6ADW4";
    const OTHER_KEY = "GCGMQIBI2B64NO4JI5IRXUOKFQYFUXBRJUUQBOHJQZA34JOKFU3W2WVK";

    it("passes the publicKey path param through to sorobanService.getAccount", async () => {
      const mockAccount = { id: PUBLIC_KEY, sequence: "98765" };
      mockSorobanService.getAccount.mockResolvedValueOnce(mockAccount);

      const result = await controller.getAccount(PUBLIC_KEY);

      expect(mockSorobanService.getAccount).toHaveBeenCalledTimes(1);
      expect(mockSorobanService.getAccount).toHaveBeenCalledWith(PUBLIC_KEY);
      expect(result).toEqual(mockAccount);
    });

    it("passes a different publicKey correctly", async () => {
      const anotherKey = "GBCI24BNYGGIRDE4PCUD6PJAQINUVQPIUJCBJT4HTZZONEXNVVDIYVAC";
      mockSorobanService.getAccount.mockResolvedValueOnce({ id: anotherKey });
      mockSorobanService.getAccount.mockResolvedValueOnce({ id: OTHER_KEY });

      await controller.getAccount(OTHER_KEY);

      expect(mockSorobanService.getAccount).toHaveBeenCalledWith(OTHER_KEY);
    });

    it("propagates errors from sorobanService.getAccount", async () => {
      mockSorobanService.getAccount.mockRejectedValueOnce(new Error("account not found"));

      await expect(controller.getAccount(PUBLIC_KEY)).rejects.toThrow("account not found");
    });

    it("rejects a strkey-shaped string with an invalid checksum", () => {
      // Same length/prefix as a real key, corrupt payload → checksum fails.
      const badChecksum = `G${PUBLIC_KEY.slice(1, -1)}A`;

      expect(() => controller.getAccount(badChecksum)).toThrow(BadRequestException);
      expect(mockSorobanService.getAccount).not.toHaveBeenCalled();
    });

    it("rejects a non-G key such as a contract id", () => {
      const contractId = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

      expect(() => controller.getAccount(contractId)).toThrow(BadRequestException);
      expect(mockSorobanService.getAccount).not.toHaveBeenCalled();
    });

    it("rejects an empty key", () => {
      expect(() => controller.getAccount("")).toThrow(BadRequestException);
      expect(mockSorobanService.getAccount).not.toHaveBeenCalled();
    });
  });
});
