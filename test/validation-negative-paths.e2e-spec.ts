import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("Validation Negative Paths (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const validCreateBody = {
    user: "GE2ETESTUSER1234567",
    srcChain: "ethereum",
    srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    srcTokenSymbol: "USDC",
    srcTokenDecimals: 6,
    srcAmount: "1000000",
    dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    dstTokenSymbol: "USDC",
    dstTokenDecimals: 7,
    minDstAmount: "990000",
  };

  describe("Pagination validation", () => {
    it("should return 400 for malformed limit (NaN)", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ limit: "not-a-number" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for malformed offset (NaN)", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ offset: "not-a-number" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for negative limit", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ limit: "-5" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for negative offset", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ offset: "-10" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("Fill amount validation", () => {
    async function createAndAcceptIntent() {
      const created = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(validCreateBody)
        .expect(201);
      const intentId = created.body.intentId;

      await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/accept`)
        .send({ solver: "SOLVER_ALPHA" })
        .expect(201);

      return intentId;
    }

    it("should return 400 for malformed fillAmount (not a number)", async () => {
      const intentId = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({ solver: "SOLVER_ALPHA", fillAmount: "not-a-number", txHash: "test" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for malformed fillAmount (BigInt overflow)", async () => {
      const intentId = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({ solver: "SOLVER_ALPHA", fillAmount: "999999999999999999999999999999999999999999999999", txHash: "test" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for negative fillAmount", async () => {
      const intentId = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({ solver: "SOLVER_ALPHA", fillAmount: "-1000", txHash: "test" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("Deadline validation", () => {
    it("should return 400 for deadline in the past", async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send({ ...validCreateBody, deadline: pastTimestamp })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for deadline as negative number", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send({ ...validCreateBody, deadline: -1 })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for non-numeric deadline", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send({ ...validCreateBody, deadline: "not-a-number" })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });
});
