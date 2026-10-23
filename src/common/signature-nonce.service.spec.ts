import { PrismaService } from "../prisma/prisma.service";
import { FakeRedis } from "../intents/backplane/testing/fake-redis";
import { SignatureNonceService } from "./signature-nonce.service";

type Backend = "prisma" | "memory" | "redis";

interface Harness {
  service: SignatureNonceService;
  /** Number of atomic check-and-set attempts made against the backing store. */
  attempts: () => number;
}

function buildPrismaHarness(): Harness {
  // Mirrors the Postgres path: the first INSERT ... ON CONFLICT wins, later
  // inserts for the same (signer, nonce) affect zero rows.
  const seen = new Set<string>();
  const executeRaw = jest.fn(async (_query: TemplateStringsArray, ...values: unknown[]) => {
    const key = `${String(values[0]).toLowerCase()}:${String(values[1])}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    return 1;
  });
  const service = new SignatureNonceService({ $executeRaw: executeRaw } as unknown as PrismaService);
  return { service, attempts: () => executeRaw.mock.calls.length };
}

function buildMemoryHarness(): Harness {
  const service = new SignatureNonceService({} as PrismaService);
  return { service, attempts: () => 0 };
}

function buildRedisHarness(redis: FakeRedis): Harness {
  const service = new SignatureNonceService({} as PrismaService, redis as never);
  return { service, attempts: () => redis.setCalls.length };
}

const backends: Backend[] = ["prisma", "memory", "redis"];

describe.each(backends)("SignatureNonceService replay-protection contract (%s backend)", (backend) => {
  const previousPersistence = process.env.INTENTS_PERSISTENCE;
  const previousStore = process.env.SIGNATURE_NONCE_STORE;
  const previousNodeEnv = process.env.NODE_ENV;

  let redis: FakeRedis;
  let harness: Harness;

  beforeEach(() => {
    process.env.INTENTS_PERSISTENCE = backend === "prisma" ? "prisma" : "memory";
    process.env.SIGNATURE_NONCE_STORE = backend;
    redis = new FakeRedis();
    harness =
      backend === "prisma"
        ? buildPrismaHarness()
        : backend === "memory"
          ? buildMemoryHarness()
          : buildRedisHarness(redis);
  });

  afterEach(() => {
    if (previousPersistence === undefined) delete process.env.INTENTS_PERSISTENCE;
    else process.env.INTENTS_PERSISTENCE = previousPersistence;
    if (previousStore === undefined) delete process.env.SIGNATURE_NONCE_STORE;
    else process.env.SIGNATURE_NONCE_STORE = previousStore;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("accepts a nonce once for a signer and rejects reuse", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;

    await expect(harness.service.consume("GSigner", "nonce-123", expiry)).resolves.toBe(true);
    await expect(harness.service.consume("GSigner", "nonce-123", expiry)).resolves.toBe(false);
  });

  it("treats signers case-insensitively", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;

    await expect(harness.service.consume("GSigner", "nonce-123", expiry)).resolves.toBe(true);
    await expect(harness.service.consume("gsigner", "nonce-123", expiry)).resolves.toBe(false);
  });

  it("allows the same nonce for a different signer", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;

    await expect(harness.service.consume("GSigner", "nonce-123", expiry)).resolves.toBe(true);
    await expect(harness.service.consume("GOther", "nonce-123", expiry)).resolves.toBe(true);
  });

  it("performs exactly one atomic check-and-set per consume call", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;

    await harness.service.consume("GSigner", "nonce-123", expiry);
    await harness.service.consume("GSigner", "nonce-456", expiry);

    if (backend !== "memory") expect(harness.attempts()).toBe(2);
  });
});

describe("SignatureNonceService redis backend", () => {
  const previousStore = process.env.SIGNATURE_NONCE_STORE;
  const previousPersistence = process.env.INTENTS_PERSISTENCE;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (previousStore === undefined) delete process.env.SIGNATURE_NONCE_STORE;
    else process.env.SIGNATURE_NONCE_STORE = previousStore;
    if (previousPersistence === undefined) delete process.env.INTENTS_PERSISTENCE;
    else process.env.INTENTS_PERSISTENCE = previousPersistence;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("uses SET key value NX EX <ttl> keyed by signer:nonce", async () => {
    process.env.SIGNATURE_NONCE_STORE = "redis";
    const redis = new FakeRedis();
    const service = new SignatureNonceService({} as PrismaService, redis as never);

    await service.consume("GSigner", "nonce-123", 1_900_000_000);

    expect(redis.setCalls).toHaveLength(1);
    const call = redis.setCalls[0];
    expect(call.key).toBe("gsigner:nonce-123");
    expect(call.options).toEqual(expect.objectContaining({ NX: true }));
    expect(call.options?.EX).toBeGreaterThan(0);
  });

  it("fails closed when Redis errors in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.SIGNATURE_NONCE_STORE = "redis";
    const redis = new FakeRedis();
    redis.failNextSet(new Error("connection reset"));
    const service = new SignatureNonceService({} as PrismaService, redis as never);

    await expect(service.consume("GSigner", "nonce-123", 1_900_000_000)).resolves.toBe(false);
  });

  it("fails closed when Redis errors outside production", async () => {
    process.env.NODE_ENV = "test";
    process.env.SIGNATURE_NONCE_STORE = "redis";
    const redis = new FakeRedis();
    redis.failNextSet(new Error("connection reset"));
    const service = new SignatureNonceService({} as PrismaService, redis as never);

    await expect(service.consume("GSigner", "nonce-123", 1_900_000_000)).resolves.toBe(false);
  });

  it("rejects the memory backend in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SIGNATURE_NONCE_STORE = "memory";
    expect(() => new SignatureNonceService({} as PrismaService)).toThrow();
  });

  it("accepts the redis backend in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SIGNATURE_NONCE_STORE = "redis";
    expect(() => new SignatureNonceService({} as PrismaService, new FakeRedis() as never)).not.toThrow();
  });
});

// Optional integration run against a real Redis service container in CI.
const describeRedisIntegration = process.env.REDIS_URL ? describe : describe.skip;

describeRedisIntegration("SignatureNonceService redis backend (real Redis)", () => {
  const previousStore = process.env.SIGNATURE_NONCE_STORE;

  afterEach(() => {
    if (previousStore === undefined) delete process.env.SIGNATURE_NONCE_STORE;
    else process.env.SIGNATURE_NONCE_STORE = previousStore;
  });

  it("accepts a nonce once and rejects reuse across service instances", async () => {
    process.env.SIGNATURE_NONCE_STORE = "redis";
    const { createClient } = await import("redis");
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    try {
      const first = new SignatureNonceService({} as PrismaService, client as never);
      const second = new SignatureNonceService({} as PrismaService, client as never);
      const expiry = Math.floor(Date.now() / 1000) + 60;
      const nonce = `it-${Date.now()}-${Math.random()}`;

      await expect(first.consume("GSigner", nonce, expiry)).resolves.toBe(true);
      await expect(second.consume("gsigner", nonce, expiry)).resolves.toBe(false);
    } finally {
      await client.quit();
    }
  });
});