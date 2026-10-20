/**
 * Abuse detector HTTP surface, end to end (issues #605, #607).
 *
 * - Admin allowlist CRUD: an entry added over HTTP is allowlisted on the very
 *   next check on the same app instance, and a removal takes effect the same way.
 * - Self-service score/audit: a correctly signed request returns only the
 *   signer's data, in the reduced view, and a valid signature for address A
 *   cannot be used to read address B.
 *
 * Postgres is replaced by an in-memory table and the Redis-backed scorer by a
 * stub keyed by address, so the suite needs no external services.
 */

import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { WsAdapter } from "@nestjs/platform-ws";
import { Prisma } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { AbuseScoreService } from "../src/abuse/abuse-score.service";
import { AllowlistService } from "../src/abuse/allowlist.service";
import { AbuseAuditEvent } from "../src/abuse/abuse.types";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";
import { enableApiVersioning } from "../src/common/api-versioning";
import { buildAbuseSelfServiceMessage } from "../src/common/stellar-signature";
import { MockPrismaService } from "./utils/create-test-app";

const ADMIN_SECRET = "abuse-e2e-admin-secret";

interface Row {
  id: string;
  type: string;
  value: string;
  label: string | null;
  createdAt: Date;
  createdBy: string;
}

class AbusePrismaMock extends MockPrismaService {
  rows: Row[] = [];
  auditRows: unknown[] = [];
  private seq = 0;

  abuseAllowlistEntry = {
    findMany: async () => [...this.rows],
    create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
      if (this.rows.some((r) => r.type === data.type && r.value === data.value)) {
        throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5.22.0" });
      }
      const row = { ...data, id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, createdAt: new Date() };
      this.rows.push(row);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const i = this.rows.findIndex((r) => r.id === where.id);
      if (i < 0) throw new Prisma.PrismaClientKnownRequestError("missing", { code: "P2025", clientVersion: "5.22.0" });
      return this.rows.splice(i, 1)[0];
    },
  };

  adminAuditLog = {
    create: async ({ data }: { data: unknown }) => {
      this.auditRows.push(data);
      return data;
    },
  };

  $transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(this);
}

const userA = Keypair.random();
const userB = Keypair.random();

const eventFor = (address: string, ip: string): AbuseAuditEvent => ({
  timestamp: "2026-10-20T00:00:00.000Z",
  userAddress: address,
  clientIp: ip,
  operation: "create",
  score: 55,
  action: "throttle",
  signals: [{ signal: "ip_asn_cluster", weight: 55, detail: `IP ${ip} associated with 9 distinct addresses` }],
  allowlisted: false,
});

const scorerStub = {
  getCachedScore: async (address: string) =>
    ({ [userA.publicKey().toLowerCase()]: 11, [userB.publicKey().toLowerCase()]: 99 })[address] ?? null,
  getAuditHistory: async (address: string) =>
    address === userA.publicKey().toLowerCase()
      ? [eventFor(address, "203.0.113.1")]
      : address === userB.publicKey().toLowerCase()
        ? [eventFor(address, "203.0.113.2")]
        : [],
  score: async () => ({ total: 0, action: "pass", signals: [], actors: [], allowlisted: false }),
  recordCancel: async () => undefined,
  onModuleDestroy: async () => undefined,
};

function signed(signer: Keypair, address = signer.publicKey(), nonce = `n-${Math.random()}`) {
  const expiresAt = Math.floor(Date.now() / 1000) + 120;
  const signature = signer
    .sign(Buffer.from(buildAbuseSelfServiceMessage(address, nonce, expiresAt), "utf8"))
    .toString("base64");
  return {
    "x-vortex-address": address,
    "x-vortex-signature": signature,
    "x-vortex-nonce": nonce,
    "x-vortex-expires-at": String(expiresAt),
  };
}

describe("Abuse endpoints (e2e)", () => {
  let app: INestApplication;
  let prisma: AbusePrismaMock;
  const previousKeys = process.env.ADMIN_API_KEYS;

  beforeAll(async () => {
    process.env.ADMIN_API_KEYS = `ops-e2e:admin:${ADMIN_SECRET}`;
    prisma = new AbusePrismaMock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AbuseScoreService)
      .useValue(scorerStub)
      .compile();

    app = moduleRef.createNestApplication();
    enableApiVersioning(app);
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousKeys === undefined) delete process.env.ADMIN_API_KEYS;
    else process.env.ADMIN_API_KEYS = previousKeys;
  });

  describe("allowlist admin API (#605)", () => {
    const partner = Keypair.random().publicKey();

    it("rejects calls without a valid admin key", async () => {
      await request(app.getHttpServer()).get("/api/v1/abuse/allowlist").expect(401);
      await request(app.getHttpServer())
        .post("/api/v1/abuse/allowlist")
        .set("x-admin-key", "wrong")
        .send({ type: "ip", value: "203.0.113.9" })
        .expect(401);
    });

    it("adds an entry that is allowlisted on the very next check, then removes it", async () => {
      const allowlist = app.get(AllowlistService);
      expect(allowlist.isAllowlisted({ userAddress: partner, clientIp: "9.9.9.9" })).toBe(false);

      const created = await request(app.getHttpServer())
        .post("/api/v1/abuse/allowlist")
        .set("x-admin-key", ADMIN_SECRET)
        .send({ type: "address", value: partner, label: "integrator" })
        .expect(201);
      expect(created.body).toMatchObject({ type: "address", value: partner.toLowerCase(), createdBy: "ops-e2e" });
      expect(allowlist.isAllowlisted({ userAddress: partner, clientIp: "9.9.9.9" })).toBe(true);

      const listed = await request(app.getHttpServer())
        .get("/api/v1/abuse/allowlist")
        .set("x-admin-key", ADMIN_SECRET)
        .expect(200);
      expect(listed.body.entries.map((e: Row) => e.id)).toContain(created.body.id);

      await request(app.getHttpServer())
        .delete(`/api/v1/abuse/allowlist/${created.body.id}`)
        .set("x-admin-key", ADMIN_SECRET)
        .expect(200);
      expect(allowlist.isAllowlisted({ userAddress: partner, clientIp: "9.9.9.9" })).toBe(false);
      expect(prisma.auditRows).toHaveLength(2);
    });

    it("stores API keys as digests and never returns the raw key", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/abuse/allowlist")
        .set("x-admin-key", ADMIN_SECRET)
        .send({ type: "api_key", value: "raw-partner-key-123" })
        .expect(201);
      expect(JSON.stringify(res.body)).not.toContain("raw-partner-key-123");
      expect(JSON.stringify(prisma.rows)).not.toContain("raw-partner-key-123");
      expect(app.get(AllowlistService).isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "raw-partner-key-123" })).toBe(true);
    });

    it("validates the body and rejects CIDR ranges and duplicates", async () => {
      const post = (body: object) =>
        request(app.getHttpServer()).post("/api/v1/abuse/allowlist").set("x-admin-key", ADMIN_SECRET).send(body);
      await post({ type: "bogus", value: "x" }).expect(400);
      await post({ type: "ip", value: "192.0.2.0/24" }).expect(400);
      await post({ type: "ip", value: "192.0.2.77" }).expect(201);
      await post({ type: "ip", value: "192.0.2.77" }).expect(409);
      await request(app.getHttpServer())
        .delete("/api/v1/abuse/allowlist/00000000-0000-4000-8000-999999999999")
        .set("x-admin-key", ADMIN_SECRET)
        .expect(404);
    });
  });

  describe("self-service score and audit (#607)", () => {
    it("returns the signer's own score", async () => {
      const res = await request(app.getHttpServer()).get("/api/v1/abuse/me/score").set(signed(userA)).expect(200);
      expect(res.body).toEqual({ address: userA.publicKey().toLowerCase(), score: 11 });
    });

    it("returns the signer's own audit in the reduced view", async () => {
      const res = await request(app.getHttpServer()).get("/api/v1/abuse/me/audit").set(signed(userA)).expect(200);
      expect(res.body.address).toBe(userA.publicKey().toLowerCase());
      expect(res.body.events).toEqual([
        {
          timestamp: "2026-10-20T00:00:00.000Z",
          operation: "create",
          action: "throttle",
          signals: [{ signal: "ip_asn_cluster", weight: 55 }],
        },
      ]);
      expect(JSON.stringify(res.body)).not.toContain("203.0.113");
    });

    it("a valid signature for address A cannot read address B", async () => {
      // A signs a message naming B: the signature does not verify against B's key.
      const forged = signed(userA, userB.publicKey());
      const res = await request(app.getHttpServer()).get("/api/v1/abuse/me/audit").set(forged).expect(401);
      expect(JSON.stringify(res.body)).not.toContain("203.0.113.2");

      // A's own valid request only ever returns A's data.
      const own = await request(app.getHttpServer()).get("/api/v1/abuse/me/score").set(signed(userA)).expect(200);
      expect(own.body.score).toBe(11);
    });

    it("rejects a replayed request and a request with no proof", async () => {
      const headers = signed(userA);
      await request(app.getHttpServer()).get("/api/v1/abuse/me/score").set(headers).expect(200);
      await request(app.getHttpServer()).get("/api/v1/abuse/me/score").set(headers).expect(401);
      await request(app.getHttpServer()).get("/api/v1/abuse/me/score").expect(401);
    });
  });
});
