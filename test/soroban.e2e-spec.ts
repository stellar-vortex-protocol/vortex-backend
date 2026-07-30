/**
 * E2E tests for /api/v1/chain/* (SorobanController)
 *
 * The Soroban routes proxy calls to a real Stellar RPC node. To avoid
 * hard network dependencies in CI these tests mock SorobanService at the
 * module level, matching the pattern used by the existing e2e suite.
 * If you want to run against a live node, remove the override block and
 * set STELLAR_SOROBAN_RPC_URL in your environment.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { WsAdapter } from "@nestjs/platform-ws";
import { ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { SorobanService } from "../src/soroban/soroban.service";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";

// ---------------------------------------------------------------------------
// Stable mock responses matching the shape returned by @stellar/stellar-sdk
// ---------------------------------------------------------------------------

const mockHealth = { status: "healthy" };

const mockLedger = {
  id: "abc123",
  sequence: 12345678,
  ledgerCloseTime: "1700000000",
};

const mockNetwork = {
  friendbotUrl: "https://friendbot-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
  protocolVersion: 21,
};

const mockAccount = {
  id: "GABC1234567890TESTPUBLICKEY000000000000000000000000000000",
  sequence: "987654321",
  balances: [
    { balance: "9999.9999800", asset_type: "native" },
  ],
};

describe("SorobanController (e2e)", () => {
  let app: INestApplication;
  let sorobanService: Record<string, jest.Mock>;

  beforeAll(async () => {
    sorobanService = {
      getHealth: jest.fn().mockResolvedValue(mockHealth),
      getLatestLedger: jest.fn().mockResolvedValue(mockLedger),
      getNetwork: jest.fn().mockResolvedValue(mockNetwork),
      getAccount: jest.fn().mockResolvedValue(mockAccount),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SorobanService)
      .useValue(sorobanService)
      .compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sorobanService.getHealth.mockResolvedValue(mockHealth);
    sorobanService.getLatestLedger.mockResolvedValue(mockLedger);
    sorobanService.getNetwork.mockResolvedValue(mockNetwork);
    sorobanService.getAccount.mockResolvedValue(mockAccount);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/chain/health
  // -------------------------------------------------------------------------

  describe("GET /api/v1/chain/health", () => {
    it("returns 200 with the RPC health payload", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/chain/health")
        .expect(200);

      expect(res.body).toMatchObject({ status: "healthy" });
      expect(sorobanService.getHealth).toHaveBeenCalledTimes(1);
    });

    it("propagates a service error as a 500", async () => {
      sorobanService.getHealth.mockRejectedValue(new Error("RPC unreachable"));

      const res = await request(app.getHttpServer())
        .get("/api/v1/chain/health")
        .expect(500);

      // NestJS wraps unhandled errors in a standard error body
      expect(res.body).toHaveProperty("statusCode", 500);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/chain/ledger
  // -------------------------------------------------------------------------

  describe("GET /api/v1/chain/ledger", () => {
    it("returns 200 with ledger metadata", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/chain/ledger")
        .expect(200);

      expect(res.body).toMatchObject({
        id: mockLedger.id,
        sequence: mockLedger.sequence,
      });
      expect(sorobanService.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    it("propagates a network error as a 500", async () => {
      sorobanService.getLatestLedger.mockRejectedValue(new Error("timeout"));

      await request(app.getHttpServer())
        .get("/api/v1/chain/ledger")
        .expect(500);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/chain/network
  // -------------------------------------------------------------------------

  describe("GET /api/v1/chain/network", () => {
    it("returns 200 with network info including the passphrase", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/chain/network")
        .expect(200);

      expect(res.body).toMatchObject({
        passphrase: mockNetwork.passphrase,
        protocolVersion: mockNetwork.protocolVersion,
      });
      expect(sorobanService.getNetwork).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/chain/account/:publicKey
  // -------------------------------------------------------------------------

  describe("GET /api/v1/chain/account/:publicKey", () => {
    const publicKey = "GABC1234567890TESTPUBLICKEY000000000000000000000000000000";

    it("returns 200 with account data for a known public key", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/chain/account/${publicKey}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: publicKey,
        sequence: mockAccount.sequence,
      });
      expect(sorobanService.getAccount).toHaveBeenCalledWith(publicKey);
    });

    it("forwards the public key parameter correctly to the service", async () => {
      const anotherKey = "GBTEST9999111122223333444455556666777788889999AAAA";
      sorobanService.getAccount.mockResolvedValue({ ...mockAccount, id: anotherKey });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/chain/account/${anotherKey}`)
        .expect(200);

      expect(sorobanService.getAccount).toHaveBeenCalledWith(anotherKey);
      expect(res.body.id).toBe(anotherKey);
    });

    it("returns 500 when the account lookup fails (e.g. account not found on chain)", async () => {
      sorobanService.getAccount.mockRejectedValue(new Error("Account not found"));

      await request(app.getHttpServer())
        .get(`/api/v1/chain/account/${publicKey}`)
        .expect(500);
    });
  });
});
