import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "../utils/create-test-app";
import { IntentsService } from "../../src/intents/intents.service";

const SOLVERS = ["SOLVER_ALPHA", "SOLVER_BETA", "SOLVER_GAMMA"];

const validCreateBody = {
  user: "GRACETESTUSER1234567",
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

describe("Concurrent accept / fill race load test", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createIntent(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(validCreateBody)
      .expect(201);
    return res.body.intentId as string;
  }

  it("only one solver wins when N concurrent accept() calls race on the same intent", async () => {
    const intentId = await createIntent();
    const concurrency = 20;

    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) => {
        const solver = SOLVERS[i % SOLVERS.length];
        return request(app.getHttpServer())
          .post(`/api/v1/intents/${intentId}/accept`)
          .send({ solver });
      }),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> => r.status === "fulfilled",
    );

    const successes = fulfilled.filter((r) => r.value.status === 201);
    const rejected = results.filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);

    const intent = (await request(app.getHttpServer()).get(`/api/v1/intents/${intentId}`).expect(200))
      .body;
    expect(intent.state).toBe("accepted");
    expect(SOLVERS).toContain(intent.solver);
  });

  it("only one solver wins when N concurrent fill() calls race on the same accepted intent", async () => {
    const intentId = await createIntent();

    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    const concurrency = 20;

    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/intents/${intentId}/fill`)
          .send({ solver: "SOLVER_ALPHA", fillAmount: "995000", txHash: `tx-${Math.random()}` }),
      ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> => r.status === "fulfilled",
    );

    const successes = fulfilled.filter((r) => r.value.status === 201);

    expect(successes).toHaveLength(1);

    const intent = (await request(app.getHttpServer()).get(`/api/v1/intents/${intentId}`).expect(200))
      .body;
    expect(intent.state).toBe("filled");
    expect(intent.fillAmount).toBe("995000");
  });

  it("mixed solvers racing for different intents all resolve with at most one winner each", async () => {
    const concurrency = 3;
    const intentIds: string[] = [];
    for (let i = 0; i < concurrency; i++) {
      intentIds.push(await createIntent());
    }

    const results = await Promise.allSettled(
      intentIds.map((id, i) => {
        const solver = SOLVERS[i % SOLVERS.length];
        return request(app.getHttpServer())
          .post(`/api/v1/intents/${id}/accept`)
          .send({ solver });
      }),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> => r.status === "fulfilled",
    );
    const successes = fulfilled.filter((r) => r.value.status === 201);
    expect(successes.length).toBeLessThanOrEqual(concurrency);

    for (const id of intentIds) {
      const intent = (await request(app.getHttpServer()).get(`/api/v1/intents/${id}`).expect(200))
        .body;
      expect(intent.state).toBe("accepted");
    }
  });

  it("unit-level: acceptIfOpen rejects concurrent calls on the same intent", () => {
    const service = new IntentsService();
    const [open] = service.getByState("open");

    const results = Array.from({ length: 50 }, (_, i) =>
      service.acceptIfOpen(open.intentId, `SOLVER_${i}`),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe("accepted");
  });

  it("unit-level: fillIfAccepted rejects concurrent calls on the same intent", () => {
    const service = new IntentsService();
    const [open] = service.getByState("open");

    service.acceptIfOpen(open.intentId, "SOLVER_X");

    const results = Array.from({ length: 50 }, () =>
      service.fillIfAccepted(open.intentId, "SOLVER_X", {
        fillAmount: "995000",
        txHash: "race-hash",
        filledAt: Math.floor(Date.now() / 1000),
      }),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe("filled");
  });
});
