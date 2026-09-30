/**
 * AbuseScoreService unit tests.
 *
 * Uses an in-memory fake Redis (ioredis-mock) so no real Redis is required.
 * Covers:
 *  - Each rule fires at threshold and not below
 *  - Composite score maps to correct action
 *  - Allowlist suppresses enforcement but still records the score
 *  - False-positive checks for legitimate high-volume integrators
 *  - Fail-open when Redis throws
 */

import { ConfigService } from "@nestjs/config";
import { AbuseScoreService } from "./abuse-score.service";
import { AbuseContext } from "./abuse.types";

// ---------------------------------------------------------------------------
// Minimal ioredis mock — we stub only the methods used by the scorer.
// ---------------------------------------------------------------------------

type PipelineCommand = { cmd: string; args: (string | number)[] };

class FakeRedisPipeline {
  private readonly store: Map<string, unknown>;
  private readonly commands: PipelineCommand[] = [];

  constructor(store: Map<string, unknown>) {
    this.store = store;
  }

  zadd(key: string, score: number, member: string) {
    this.commands.push({ cmd: "zadd", args: [key, score, member] });
    return this;
  }
  zremrangebyscore(key: string, min: string | number, max: string | number) {
    this.commands.push({ cmd: "zremrangebyscore", args: [key, min, max] });
    return this;
  }
  expire(key: string, ttl: number) {
    this.commands.push({ cmd: "expire", args: [key, ttl] });
    return this;
  }
  lpush(key: string, value: string) {
    this.commands.push({ cmd: "lpush", args: [key, value] });
    return this;
  }
  ltrim(key: string, start: number, stop: number) {
    this.commands.push({ cmd: "ltrim", args: [key, start, stop] });
    return this;
  }
  set(key: string, value: string, _ex?: string, _ttl?: number) {
    this.commands.push({ cmd: "set", args: [key, value] });
    return this;
  }

  async exec() {
    // Apply zadd and set to the shared store so subsequent zcount sees results.
    for (const { cmd, args } of this.commands) {
      if (cmd === "zadd") {
        const key = args[0] as string;
        const existing = (this.store.get(key) as Map<string, number>) ?? new Map<string, number>();
        existing.set(args[2] as string, args[1] as number);
        this.store.set(key, existing);
      }
      if (cmd === "set") {
        this.store.set(args[0] as string, args[1]);
      }
    }
    return this.commands.map(() => [null, 1]);
  }
}

class FakeRedis {
  private readonly store = new Map<string, unknown>();
  private shouldThrow = false;

  simulateError(v = true) {
    this.shouldThrow = v;
  }

  on(_event: string, _handler: unknown) {
    return this;
  }

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    if (this.shouldThrow) throw new Error("Redis connection refused");
    const sorted = (this.store.get(key) as Map<string, number> | undefined) ?? new Map();
    const minN = min === "-inf" ? -Infinity : Number(min);
    const maxN = max === "+inf" ? Infinity : Number(max);
    let count = 0;
    for (const score of sorted.values()) {
      if (score >= minN && score <= maxN) count++;
    }
    return count;
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    if (this.shouldThrow) throw new Error("Redis connection refused");
    const sorted = (this.store.get(key) as Map<string, number> | undefined) ?? new Map();
    const minN = min === "-inf" ? -Infinity : Number(min);
    const maxN = max === "+inf" ? Infinity : Number(max);
    const results: string[] = [];
    for (const [member, score] of sorted.entries()) {
      if (score >= minN && score <= maxN) results.push(member);
    }
    return results;
  }

  async get(key: string): Promise<string | null> {
    if (this.shouldThrow) throw new Error("Redis connection refused");
    return (this.store.get(key) as string | null) ?? null;
  }

  async lrange(_key: string, _start: number, _stop: number): Promise<string[]> {
    return [];
  }

  pipeline() {
    return new FakeRedisPipeline(this.store);
  }

  disconnect() {}

  /** Seed a sorted-set entry directly for test setup. */
  seedZset(key: string, members: Array<{ score: number; member: string }>) {
    const existing = (this.store.get(key) as Map<string, number>) ?? new Map();
    for (const { score, member } of members) existing.set(member, score);
    this.store.set(key, existing);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(): ConfigService {
  return {
    get: (_key: string) => "redis://localhost:6379",
  } as unknown as ConfigService;
}

function makeCtx(overrides: Partial<AbuseContext> = {}): AbuseContext {
  return {
    userAddress: "gabc123",
    clientIp: "1.2.3.4",
    srcAmount: "1000000",
    srcTokenPriceUsd: 1.0,
    srcTokenDecimals: 6,
    intentFingerprint: "aabbccdd11223344",
    operation: "create",
    ...overrides,
  };
}

function buildService(fakeRedis: FakeRedis): AbuseScoreService {
  const svc = new AbuseScoreService(makeConfigService() as ConfigService);
  // Replace the ioredis instance with our fake
  (svc as unknown as { redis: FakeRedis }).redis = fakeRedis;
  return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AbuseScoreService", () => {
  let fake: FakeRedis;
  let svc: AbuseScoreService;

  beforeEach(() => {
    fake = new FakeRedis();
    svc = buildService(fake);
  });

  // ── fail-open ─────────────────────────────────────────────────────────────

  it("fails open (returns score=0/action=pass) when Redis throws", async () => {
    fake.simulateError(true);
    const result = await svc.score(makeCtx(), false);
    expect(result.action).toBe("pass");
    expect(result.total).toBe(0);
  });

  // ── dust_intent rule ──────────────────────────────────────────────────────

  it("does NOT fire dust_intent for amounts above threshold", async () => {
    // $1 USD intent (1_000_000 base units at $1 = $1.00 > $0.01 threshold)
    const result = await svc.score(makeCtx({ srcAmount: "1000000", srcTokenPriceUsd: 1.0, srcTokenDecimals: 6 }), false);
    const dustFired = result.signals.some((s) => s.signal === "dust_intent");
    expect(dustFired).toBe(false);
  });

  it("fires dust_intent for amounts below threshold ($0.0001)", async () => {
    // 100 base units at $0.001/unit = $0.0001 — well below $0.01 dust threshold
    const result = await svc.score(makeCtx({ srcAmount: "100", srcTokenPriceUsd: 0.001, srcTokenDecimals: 6 }), false);
    const dustFired = result.signals.some((s) => s.signal === "dust_intent");
    expect(dustFired).toBe(true);
  });

  it("does NOT fire dust_intent when price is 0 (unknown)", async () => {
    const result = await svc.score(makeCtx({ srcTokenPriceUsd: 0 }), false);
    expect(result.signals.some((s) => s.signal === "dust_intent")).toBe(false);
  });

  // ── new_address rule ──────────────────────────────────────────────────────

  it("fires new_address when account is fresh (100 seconds old)", async () => {
    const result = await svc.score(makeCtx({ accountAgeSeconds: 100 }), false);
    expect(result.signals.some((s) => s.signal === "new_address")).toBe(true);
  });

  it("does NOT fire new_address when account is over 1 day old", async () => {
    const result = await svc.score(makeCtx({ accountAgeSeconds: 90_000 }), false);
    expect(result.signals.some((s) => s.signal === "new_address")).toBe(false);
  });

  it("does NOT fire new_address when accountAgeSeconds is undefined (not yet fetched)", async () => {
    const result = await svc.score(makeCtx({ accountAgeSeconds: undefined }), false);
    expect(result.signals.some((s) => s.signal === "new_address")).toBe(false);
  });

  // ── create_cancel_ratio rule ──────────────────────────────────────────────

  it("does NOT fire create_cancel_ratio below minCreates threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    // 3 creates, 3 cancels — below minCreates=5
    const createKey = "vortex:abuse:user:gabc123:creates";
    const cancelKey = "vortex:abuse:user:gabc123:cancels";
    for (let i = 0; i < 3; i++) {
      fake.seedZset(createKey, [{ score: now, member: `c${i}` }]);
      fake.seedZset(cancelKey, [{ score: now, member: `x${i}` }]);
    }
    const result = await svc.score(makeCtx(), false);
    expect(result.signals.some((s) => s.signal === "create_cancel_ratio")).toBe(false);
  });

  it("fires create_cancel_ratio when 80%+ creates are cancelled (5+ creates)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const createKey = "vortex:abuse:user:spammer:creates";
    const cancelKey = "vortex:abuse:user:spammer:cancels";
    // 10 creates, 9 cancels = 90% ratio ≥ 80%
    for (let i = 0; i < 10; i++) {
      fake.seedZset(createKey, [{ score: now, member: `c${i}` }]);
    }
    for (let i = 0; i < 9; i++) {
      fake.seedZset(cancelKey, [{ score: now, member: `x${i}` }]);
    }
    const result = await svc.score(makeCtx({ userAddress: "spammer" }), false);
    expect(result.signals.some((s) => s.signal === "create_cancel_ratio")).toBe(true);
  });

  // ── burst_identical rule ──────────────────────────────────────────────────

  it("fires burst_identical when same fingerprint appears 3+ times in window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fp = "aabbccdd11223344";
    const key = `vortex:abuse:user:gabc123:fp:${fp}`;
    fake.seedZset(key, [
      { score: now, member: "a" },
      { score: now, member: "b" },
      { score: now, member: "c" },
    ]);
    const result = await svc.score(makeCtx({ intentFingerprint: fp }), false);
    expect(result.signals.some((s) => s.signal === "burst_identical")).toBe(true);
  });

  it("does NOT fire burst_identical below maxCount", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fp = "aabbccdd11223344";
    const key = `vortex:abuse:user:gabc123:fp:${fp}`;
    fake.seedZset(key, [
      { score: now, member: "a" },
      { score: now, member: "b" },
    ]);
    const result = await svc.score(makeCtx({ intentFingerprint: fp }), false);
    expect(result.signals.some((s) => s.signal === "burst_identical")).toBe(false);
  });

  // ── ip_asn_cluster rule ───────────────────────────────────────────────────

  it("fires ip_asn_cluster when 5+ distinct addresses come from the same IP", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = "vortex:abuse:ip:1.2.3.4:users";
    const addresses = ["addr1", "addr2", "addr3", "addr4", "addr5"];
    fake.seedZset(key, addresses.map((a) => ({ score: now, member: `${now}:${a}` })));
    const result = await svc.score(makeCtx({ clientIp: "1.2.3.4" }), false);
    expect(result.signals.some((s) => s.signal === "ip_asn_cluster")).toBe(true);
  });

  it("does NOT fire ip_asn_cluster below minAddressesPerIp", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = "vortex:abuse:ip:1.2.3.4:users";
    fake.seedZset(key, [
      { score: now, member: `${now}:addr1` },
      { score: now, member: `${now}:addr2` },
    ]);
    const result = await svc.score(makeCtx({ clientIp: "1.2.3.4" }), false);
    expect(result.signals.some((s) => s.signal === "ip_asn_cluster")).toBe(false);
  });

  // ── solver_spam rule ──────────────────────────────────────────────────────

  it("fires solver_spam when solver performs 10+ cycles in window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = "vortex:abuse:solver:gsolver1:cycles";
    for (let i = 0; i < 10; i++) {
      fake.seedZset(key, [{ score: now, member: `c${i}` }]);
    }
    const result = await svc.score(
      makeCtx({ solverAddress: "gsolver1", operation: "accept" }),
      false,
    );
    expect(result.signals.some((s) => s.signal === "solver_spam")).toBe(true);
  });

  it("does NOT fire solver_spam for normal operations", async () => {
    const result = await svc.score(
      makeCtx({ solverAddress: "gsolver1", operation: "accept" }),
      false,
    );
    expect(result.signals.some((s) => s.signal === "solver_spam")).toBe(false);
  });

  // ── Score → action mapping ─────────────────────────────────────────────────

  it("maps score=0 to action=pass", async () => {
    const result = await svc.score(makeCtx(), false);
    expect(result.action).toBe("pass");
  });

  it("maps score≥30 to action=challenge", async () => {
    // Trigger new_address (weight=15) + dust_intent (weight=20) = 35
    const result = await svc.score(
      makeCtx({ accountAgeSeconds: 100, srcAmount: "100", srcTokenPriceUsd: 0.001 }),
      false,
    );
    expect(result.total).toBeGreaterThanOrEqual(30);
    expect(result.action).toBe("challenge");
  });

  it("maps score≥90 to action=block", async () => {
    const now = Math.floor(Date.now() / 1000);
    const userAddress = "heavyspammer";

    // create_cancel_ratio (40) + ip_asn_cluster (50) = 90 → block
    const createKey = `vortex:abuse:user:${userAddress}:creates`;
    const cancelKey = `vortex:abuse:user:${userAddress}:cancels`;
    for (let i = 0; i < 10; i++) {
      fake.seedZset(createKey, [{ score: now, member: `c${i}` }]);
    }
    for (let i = 0; i < 9; i++) {
      fake.seedZset(cancelKey, [{ score: now, member: `x${i}` }]);
    }
    const ipKey = "vortex:abuse:ip:9.8.7.6:users";
    const addrs = ["a1", "a2", "a3", "a4", "a5"];
    fake.seedZset(ipKey, addrs.map((a) => ({ score: now, member: `${now}:${a}` })));

    const result = await svc.score(
      makeCtx({ userAddress, clientIp: "9.8.7.6" }),
      false,
    );
    expect(result.total).toBeGreaterThanOrEqual(90);
    expect(result.action).toBe("block");
  });

  // ── Allowlist suppresses enforcement ──────────────────────────────────────

  it("returns action=pass for allowlisted actor even when score is high", async () => {
    const now = Math.floor(Date.now() / 1000);
    const userAddress = "allowlisted-integrator";
    const createKey = `vortex:abuse:user:${userAddress}:creates`;
    const cancelKey = `vortex:abuse:user:${userAddress}:cancels`;
    for (let i = 0; i < 10; i++) {
      fake.seedZset(createKey, [{ score: now, member: `c${i}` }]);
    }
    for (let i = 0; i < 9; i++) {
      fake.seedZset(cancelKey, [{ score: now, member: `x${i}` }]);
    }

    const result = await svc.score(makeCtx({ userAddress }), true /* allowlisted */);
    expect(result.allowlisted).toBe(true);
    expect(result.action).toBe("pass");
    // Score is still computed and non-zero for transparency
    expect(result.total).toBeGreaterThan(0);
  });

  // ── False-positive: legitimate high-volume pattern ────────────────────────

  it("does NOT flag a legitimate integrator with steady creation and no cancellations", async () => {
    const now = Math.floor(Date.now() / 1000);
    const userAddress = "legit-market-maker";
    // 50 creates, 0 cancels, varied parameters, well-funded amounts
    const createKey = `vortex:abuse:user:${userAddress}:creates`;
    for (let i = 0; i < 50; i++) {
      fake.seedZset(createKey, [{ score: now - i * 10, member: `c${i}` }]);
    }
    const result = await svc.score(
      makeCtx({
        userAddress,
        srcAmount: "10000000000", // large amount, clearly not dust
        srcTokenPriceUsd: 2.5,
        srcTokenDecimals: 6,
        accountAgeSeconds: 180 * 86_400, // 180 days old
      }),
      false,
    );
    expect(result.action).toBe("pass");
    expect(result.signals.filter((s) => ["dust_intent", "new_address"].includes(s.signal))).toHaveLength(0);
  });

  it("does NOT flag an old address with no abuse signals", async () => {
    const result = await svc.score(
      makeCtx({
        accountAgeSeconds: 365 * 86_400,
        srcAmount: "5000000",
        srcTokenPriceUsd: 10,
        srcTokenDecimals: 6,
      }),
      false,
    );
    expect(result.action).toBe("pass");
    expect(result.total).toBe(0);
  });

  // ── recordCancel ──────────────────────────────────────────────────────────

  it("recordCancel does not throw when Redis is available", async () => {
    await expect(svc.recordCancel("gabc123")).resolves.not.toThrow();
  });

  it("recordCancel does not throw when Redis errors", async () => {
    fake.simulateError(true);
    await expect(svc.recordCancel("gabc123")).resolves.not.toThrow();
  });
});
