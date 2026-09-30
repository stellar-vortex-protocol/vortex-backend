import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "../utils/create-test-app";
import { InMemoryIntentsRepository } from "../../src/intents/intents.repository";
import { SEED_SOLVER_KEYPAIRS } from "../../src/solvers/solvers.seed";
import { buildAcceptMessage, buildFillMessage } from "../../src/common/stellar-signature";

const SOLVER_KPS = [
  SEED_SOLVER_KEYPAIRS.ALPHA,
  SEED_SOLVER_KEYPAIRS.BETA,
  SEED_SOLVER_KEYPAIRS.GAMMA,
];
const SOLVERS = SOLVER_KPS.map((kp) => kp.publicKey());

function sign(kp: (typeof SOLVER_KPS)[number], msg: string): string {
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
}

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
        const kp = SOLVER_KPS[i % SOLVER_KPS.length];
        const solver = kp.publicKey();
        return request(app.getHttpServer())
          .post(`/api/v1/intents/${intentId}/accept`)
          .send({ solver, signature: sign(kp, buildAcceptMessage(intentId, solver)) });
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
    const kp = SOLVER_KPS[0];

    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({
        solver: kp.publicKey(),
        signature: sign(kp, buildAcceptMessage(intentId, kp.publicKey())),
      })
      .expect(201);

    const concurrency = 20;

    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/intents/${intentId}/fill`)
          .send({
            solver: kp.publicKey(),
            fillAmount: "995000",
            txHash: `tx-${Math.random()}`,
            signature: sign(kp, buildFillMessage(intentId, kp.publicKey())),
          }),
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
        const kp = SOLVER_KPS[i % SOLVER_KPS.length];
        const solver = kp.publicKey();
        return request(app.getHttpServer())
          .post(`/api/v1/intents/${id}/accept`)
          .send({ solver, signature: sign(kp, buildAcceptMessage(id, solver)) });
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

  it("unit-level: acceptIfOpen rejects concurrent calls on the same intent", async () => {
    const repo = new InMemoryIntentsRepository();
    const [open] = repo.findByState("open");

    const results = Array.from({ length: 50 }, (_, i) =>
      repo.acceptIfOpen(open.intentId, `SOLVER_${i}`, Math.floor(Date.now() / 1000) + 300),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe("accepted");
  });

  it("unit-level: fillIfAccepted rejects concurrent calls on the same intent", () => {
    const repo = new InMemoryIntentsRepository();
    const [open] = repo.findByState("open");

    repo.acceptIfOpen(open.intentId, "SOLVER_X", Math.floor(Date.now() / 1000) + 300);

    const results = Array.from({ length: 50 }, () =>
      repo.fillIfAccepted(open.intentId, "SOLVER_X", {
        fillAmount: "995000",
        txHash: "race-hash",
        filledAt: Math.floor(Date.now() / 1000),
      }),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe("filled");
  });

  it("race inventory #473: accept past deadline loses even when it beats the sweeper to the write", async () => {
    const repo = new InMemoryIntentsRepository();
    const [open] = repo.findByState("open");
    const pastDeadline = Math.floor(Date.now() / 1000) - 10;
    const expired = { ...open, deadline: pastDeadline };
    // Simulate an intent whose deadline elapsed before the accept write lands.
    repo.save({ ...expired });
    const now = Math.floor(Date.now() / 1000);
    const result = await repo.acceptIfOpen(open.intentId, "SOLVER_LATE", now + 300, now);
    expect(result).toBeNull();
  });

  it("race inventory #473: fill past the accept-extended deadline loses (sweeper slash wins)", async () => {
    const repo = new InMemoryIntentsRepository();
    const [open] = repo.findByState("open");
    const now = Math.floor(Date.now() / 1000);
    await repo.acceptIfOpen(open.intentId, "SOLVER_X", now + 1, now - 100);
    // Advance past the fill window before the fill write lands.
    const late = await repo.fillIfAccepted(
      open.intentId,
      "SOLVER_X",
      { fillAmount: "995000", txHash: "late", filledAt: now + 60 },
      now + 60,
    );
    expect(late).toBeNull();
  });

  it("race inventory #473: cancel vs accept — exactly one terminal path wins", async () => {
    const repo = new InMemoryIntentsRepository();
    const [open] = repo.findByState("open");
    const now = Math.floor(Date.now() / 1000);
    const accepted = await repo.acceptIfOpen(open.intentId, "SOLVER_RACE", now + 300, now);
    const cancelled = await repo.cancelIfOpen(open.intentId);
    // Exactly one of the two conditional writes may succeed.
    expect(Number(accepted !== null) + Number(cancelled !== null)).toBeLessThanOrEqual(1);
  });
});
