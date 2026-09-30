import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildAcceptMessage, buildFillMessage } from "../src/common/stellar-signature";

const ALPHA_KP = SEED_SOLVER_KEYPAIRS.ALPHA;

function sign(kp: Keypair, msg: string): string {
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
}

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
    minDstAmount: "9900000",
  };

  // Distinct user per create attempt so the per-user create throttle
  // (10 / 60 s, issue #45) never trips inside this suite.
  let userSeq = 0;
  function body(overrides: Record<string, unknown> = {}) {
    return {
      ...validCreateBody,
      user: `GE2ETESTUSER${String(++userSeq).padStart(10, "0")}`,
      ...overrides,
    };
  }

  describe("Intent creation validation", () => {
    it("should return 400 for same-asset self-swaps on Stellar", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(
          body({
            srcChain: "stellar",
            srcTokenAddress: validCreateBody.dstTokenContract,
            srcTokenSymbol: "USDC",
            srcAmount: "1000000",
            dstTokenContract: validCreateBody.dstTokenContract,
            dstTokenSymbol: "USDC",
          }),
        )
        .expect(400);

      expect(res.body.error).toBe("Validation failed");
      expect(res.body.details).toEqual(
        expect.arrayContaining([expect.stringContaining("Self-swaps are not allowed")]),
      );
    });
  });

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
    async function createAndAcceptIntent(): Promise<{ intentId: string; signature: string }> {
      const created = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(body())
        .expect(201);
      const intentId = created.body.intentId;

      const acceptSig = sign(ALPHA_KP, buildAcceptMessage(intentId, ALPHA_KP.publicKey()));
      await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/accept`)
        .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
        .expect(201);

      return { intentId, signature: sign(ALPHA_KP, buildFillMessage(intentId, ALPHA_KP.publicKey())) };
    }

    it("should return 400 for malformed fillAmount (not a number)", async () => {
      const { intentId, signature } = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({ solver: ALPHA_KP.publicKey(), fillAmount: "not-a-number", txHash: "test", signature })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("accepts a fillAmount beyond Number.MAX_SAFE_INTEGER (BigInt has no overflow)", async () => {
      const { intentId, signature } = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({
          solver: ALPHA_KP.publicKey(),
          fillAmount: "999999999999999999999999999999999999999999999999",
          txHash: "test",
          signature,
        })
        .expect(201);
      expect(res.body.state).toBe("filled");
      expect(res.body.fillAmount).toBe("999999999999999999999999999999999999999999999999");
    });

    it("should return 400 for negative fillAmount", async () => {
      const { intentId, signature } = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({ solver: ALPHA_KP.publicKey(), fillAmount: "-1000", txHash: "test", signature })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for oversized signature strings", async () => {
      const { intentId } = await createAndAcceptIntent();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/intents/${intentId}/fill`)
        .send({
          solver: ALPHA_KP.publicKey(),
          fillAmount: "1000",
          txHash: "test",
          signature: "A".repeat(89),
        })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("List filter enum validation (#270)", () => {
    it("should return 400 for an unknown state filter", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ state: "bogus", limit: 20, offset: 0 })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for an unknown chain filter", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ chain: "notachain", limit: 20, offset: 0 })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should still accept a valid state filter", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ state: "open", limit: 20, offset: 0 })
        .expect(200);
    });
  });

  describe("Advanced search validation (#440)", () => {
    it("should return 400 when minAmountUsd exceeds maxAmountUsd", async () => {
      // An inverted range can never match anything; rejecting it is clearer than
      // silently returning an empty page the caller has to interpret.
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ minAmountUsd: 500, maxAmountUsd: 100 })
        .expect(400);
      // HttpExceptionFilter normalises every error to a single `error` string.
      expect(res.body.error).toMatch(/minAmountUsd/);
    });

    it("should accept a minAmountUsd equal to maxAmountUsd", async () => {
      // Equal bounds are a legitimate single-value query, not an inversion.
      await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ minAmountUsd: 100, maxAmountUsd: 100 })
        .expect(200);
    });

    it("should accept an open-ended USD range", async () => {
      await request(app.getHttpServer()).get("/api/v1/intents").query({ minAmountUsd: 0 }).expect(200);
      await request(app.getHttpServer()).get("/api/v1/intents").query({ maxAmountUsd: 1000 }).expect(200);
    });

    it("should return 400 when createdFrom exceeds createdTo", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ createdFrom: 2_000_000, createdTo: 1_000_000 })
        .expect(400);
      expect(res.body.error).toMatch(/createdFrom/);
    });

    it("should accept a single-instant creation window", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ createdFrom: 1_000_000, createdTo: 1_000_000 })
        .expect(200);
    });

    it("should return 400 for a negative USD bound", async () => {
      await request(app.getHttpServer()).get("/api/v1/intents").query({ minAmountUsd: -1 }).expect(400);
    });

    it("should return 400 for a negative creation timestamp", async () => {
      await request(app.getHttpServer()).get("/api/v1/intents").query({ createdFrom: -5 }).expect(400);
    });

    it("should return 400 for a non-numeric USD bound", async () => {
      await request(app.getHttpServer()).get("/api/v1/intents").query({ minAmountUsd: "abc" }).expect(400);
    });

    it.each([
      "usd:sideways",
      "nonsense",
      "created:up",
      "createdAt",
      "",
      "created:asc:desc",
    ])("should return 400 for the invalid sort %p", async (sort) => {
      // Only created|deadline|usd, optionally with :asc or :desc. An open sort
      // parameter would be attacker-controlled ordering on an indexed column.
      await request(app.getHttpServer()).get("/api/v1/intents").query({ sort }).expect(400);
    });

    it.each(["created", "created:asc", "created:desc", "deadline:asc", "usd", "usd:desc"])(
      "should accept the valid sort %p",
      async (sort) => {
        await request(app.getHttpServer()).get("/api/v1/intents").query({ sort }).expect(200);
      },
    );

    it("should return 400 for a negative offset", async () => {
      await request(app.getHttpServer()).get("/api/v1/intents").query({ offset: -1 }).expect(400);
    });

    it("should return 400 for a zero limit", async () => {
      // limit=0 would be a request for an empty page with a non-zero total,
      // which reads like a bug to every client.
      await request(app.getHttpServer()).get("/api/v1/intents").query({ limit: 0 }).expect(400);
    });

    it("should return 400 for a limit above the maximum", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ limit: 101 })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return the pagination metadata alongside the results", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/intents")
        .query({ limit: 5, offset: 0 })
        .expect(200);
      // Clients page off these, so they must always be present and truthful.
      expect(res.body).toHaveProperty("intents");
      expect(res.body).toHaveProperty("total");
      expect(res.body.limit).toBe(5);
      expect(res.body.offset).toBe(0);
      expect(Array.isArray(res.body.intents)).toBe(true);
    });
  });

  describe("Unknown destination/source token rejection (#276)", () => {
    it("should return 400 for a well-formed but unregistered dstTokenContract", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(
          body({ dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMZZZZZZ" }),
        )
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for a well-formed but unregistered srcTokenAddress on a known chain", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(body({ srcTokenAddress: "0x1111111111111111111111111111111111111111" }))
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("Deadline validation", () => {
    it("should return 400 for deadline in the past", async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(body({ deadline: pastTimestamp }))
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for deadline as negative number", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(body({ deadline: -1 }))
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for non-numeric deadline", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(body({ deadline: "not-a-number" }))
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });
});
