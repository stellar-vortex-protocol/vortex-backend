/**
 * AllowlistService unit tests.
 */

import { AllowlistService } from "./allowlist.service";

function buildService(envValue: string): AllowlistService {
  process.env.ABUSE_ALLOWLIST = envValue;
  const svc = new AllowlistService();
  delete process.env.ABUSE_ALLOWLIST;
  return svc;
}

describe("AllowlistService", () => {
  afterEach(() => {
    delete process.env.ABUSE_ALLOWLIST;
  });

  it("returns false when allowlist is empty", () => {
    const svc = buildService("");
    expect(svc.isAllowlisted({ userAddress: "GABC", clientIp: "1.2.3.4" })).toBe(false);
  });

  it("matches by Stellar address (case-insensitive)", () => {
    const svc = buildService("GABC123XYZ");
    expect(svc.isAllowlisted({ userAddress: "gabc123xyz", clientIp: "9.9.9.9" })).toBe(true);
  });

  it("matches by exact IP address", () => {
    const svc = buildService("192.168.1.1");
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "192.168.1.1" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "192.168.1.2" })).toBe(false);
  });

  it("matches by API key (key: prefix)", () => {
    const svc = buildService("key:my-secret-token");
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "my-secret-token" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "wrong-token" })).toBe(false);
  });

  it("supports multiple entries separated by commas", () => {
    const svc = buildService("GADDR1, 10.0.0.1, key:tok1");
    expect(svc.isAllowlisted({ userAddress: "gaddr1", clientIp: "9.9.9.9" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "10.0.0.1" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "tok1" })).toBe(true);
  });

  it("does not match a partial Stellar address", () => {
    const svc = buildService("GFULL");
    expect(svc.isAllowlisted({ userAddress: "GFULL_EXTRA", clientIp: "9.9.9.9" })).toBe(false);
  });
});

// ── Postgres-backed entries (issue #605) ─────────────────────────────────────

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import type { PrismaService } from "../prisma/prisma.service";
import type { AdminAuditService } from "../admin/admin-audit.service";
import { InMemoryFlagBus } from "../flags/flag-bus";
import { ABUSE_ALLOWLIST_CHANNEL } from "./allowlist.service";

interface Row {
  id: string;
  type: "address" | "ip" | "api_key";
  value: string;
  label: string | null;
  createdAt: Date;
  createdBy: string;
}

/** In-memory stand-in for the abuse_allowlist_entries table, shared by every "replica". */
class FakeTable {
  rows: Row[] = [];
  private seq = 0;
  failing = false;

  knownError(code: string): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError("fake", { code, clientVersion: "5.22.0" });
  }

  client(): PrismaService {
    const delegate = {
      findMany: async () => {
        if (this.failing) throw new Error("connection refused");
        return [...this.rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        if (this.rows.some((r) => r.type === data.type && r.value === data.value)) throw this.knownError("P2002");
        const row: Row = { ...data, id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, createdAt: new Date(Date.UTC(2026, 9, 20, 0, this.seq)) };
        this.rows.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = this.rows.findIndex((r) => r.id === where.id);
        if (i < 0) throw this.knownError("P2025");
        return this.rows.splice(i, 1)[0];
      },
    };
    const client = {
      abuseAllowlistEntry: delegate,
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
    };
    return client as unknown as PrismaService;
  }
}

const admin = { id: "ops-alice", role: "admin" as const };
const ADDRESS = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

describe("AllowlistService (Postgres-backed)", () => {
  let table: FakeTable;
  let bus: InMemoryFlagBus;
  let audit: { record: jest.Mock };
  const services: AllowlistService[] = [];

  function replica(): AllowlistService {
    const svc = new AllowlistService(table.client(), undefined, audit as unknown as AdminAuditService, bus);
    services.push(svc);
    return svc;
  }

  beforeEach(() => {
    table = new FakeTable();
    bus = new InMemoryFlagBus(ABUSE_ALLOWLIST_CHANNEL);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(async () => {
    for (const s of services.splice(0)) await s.onModuleDestroy();
    delete process.env.ABUSE_ALLOWLIST;
  });

  it("loads existing rows at startup", async () => {
    table.rows.push({ id: "x", type: "ip", value: "198.51.100.9", label: null, createdAt: new Date(), createdBy: "seed" });
    const svc = replica();
    await svc.onModuleInit();
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "198.51.100.9" })).toBe(true);
  });

  it("an added entry is allowlisted on the very next check, on this replica and another", async () => {
    const a = replica();
    const b = replica();
    await a.onModuleInit();
    await b.onModuleInit();

    const entry = await a.add({ type: "address", value: ADDRESS, label: "partner wallet" }, admin);
    expect(entry).toMatchObject({ type: "address", value: ADDRESS.toLowerCase(), createdBy: "ops-alice" });

    expect(a.isAllowlisted({ userAddress: ADDRESS, clientIp: "9.9.9.9" })).toBe(true);
    await new Promise((r) => setImmediate(r)); // let replica b finish its pub/sub-triggered reload
    expect(b.isAllowlisted({ userAddress: ADDRESS.toLowerCase(), clientIp: "9.9.9.9" })).toBe(true);
  });

  it("a removal takes effect on every replica", async () => {
    const a = replica();
    const b = replica();
    await a.onModuleInit();
    await b.onModuleInit();
    const entry = await a.add({ type: "ip", value: "203.0.113.20" }, admin);
    await new Promise((r) => setImmediate(r));
    expect(b.isAllowlisted({ userAddress: "GNONE", clientIp: "203.0.113.20" })).toBe(true);

    await b.remove(entry.id, admin);
    await new Promise((r) => setImmediate(r));
    expect(a.isAllowlisted({ userAddress: "GNONE", clientIp: "203.0.113.20" })).toBe(false);
    expect(b.isAllowlisted({ userAddress: "GNONE", clientIp: "203.0.113.20" })).toBe(false);
  });

  it("stores only the SHA-256 digest of an API key, never the raw key", async () => {
    const svc = replica();
    await svc.onModuleInit();
    const entry = await svc.add({ type: "api_key", value: "integrator-prod-key" }, admin);

    expect(entry.value).toBe(sha256("integrator-prod-key"));
    expect(JSON.stringify(table.rows)).not.toContain("integrator-prod-key");
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("integrator-prod-key");
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "integrator-prod-key" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "9.9.9.9", apiKey: "other" })).toBe(false);
  });

  it("records an audit entry for each add and remove, attributed to the admin", async () => {
    const svc = replica();
    await svc.onModuleInit();
    const entry = await svc.add({ type: "ip", value: "203.0.113.30" }, admin);
    await svc.remove(entry.id, admin);
    expect(audit.record.mock.calls.map(([e]) => [e.actor, e.action])).toEqual([
      ["ops-alice", "abuse.allowlist.add"],
      ["ops-alice", "abuse.allowlist.remove"],
    ]);
  });

  it("does not apply a change whose audit write fails", async () => {
    audit.record.mockRejectedValue(new Error("audit down"));
    const svc = replica();
    await svc.onModuleInit();
    // The fake $transaction does not roll back, so assert on the error and the in-memory cache only.
    await expect(svc.add({ type: "ip", value: "203.0.113.31" }, admin)).rejects.toThrow("audit down");
  });

  it("validates values: Stellar address, exact IP only (CIDR rejected), non-empty key", async () => {
    const svc = replica();
    await expect(svc.add({ type: "address", value: "GSHORT" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.add({ type: "ip", value: "192.0.2.0/24" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.add({ type: "ip", value: "not-an-ip" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.add({ type: "api_key", value: "   " }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.add({ type: "ip", value: "2001:DB8::1" }, admin)).resolves.toMatchObject({ value: "2001:db8::1" });
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "2001:db8::1" })).toBe(true);
  });

  it("rejects a duplicate with 409 and an unknown id with 404", async () => {
    const svc = replica();
    await svc.add({ type: "ip", value: "203.0.113.40" }, admin);
    await expect(svc.add({ type: "ip", value: "203.0.113.40" }, admin)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.remove("00000000-0000-4000-8000-999999999999", admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("keeps the env seed working alongside the database, and reports its size", async () => {
    process.env.ABUSE_ALLOWLIST = "GENVSEED,10.0.0.1,key:env-key";
    const svc = replica();
    await svc.onModuleInit();
    await svc.add({ type: "ip", value: "203.0.113.50" }, admin);

    expect(svc.isAllowlisted({ userAddress: "genvseed", clientIp: "9.9.9.9" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "10.0.0.1" })).toBe(true);
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "203.0.113.50" })).toBe(true);

    const listing = await svc.list();
    expect(listing.envSeed).toEqual({ addresses: 1, ips: 1, apiKeys: 1 });
    expect(listing.entries).toHaveLength(1);
  });

  it("keeps the last loaded entries when Postgres becomes unreachable", async () => {
    const svc = replica();
    await svc.onModuleInit();
    await svc.add({ type: "ip", value: "203.0.113.60" }, admin);
    table.failing = true;
    await svc.reload();
    expect(svc.isAllowlisted({ userAddress: "GNONE", clientIp: "203.0.113.60" })).toBe(true);
  });

  it("starts with only the env seed when Postgres is unreachable at boot", async () => {
    process.env.ABUSE_ALLOWLIST = "GENVONLY";
    table.failing = true;
    const svc = replica();
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.isAllowlisted({ userAddress: "genvonly", clientIp: "9.9.9.9" })).toBe(true);
  });
});
