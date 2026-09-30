/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight Prisma fakes */
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { AdminAuditService } from "../admin/admin-audit.service";
import { GuardianStateService } from "../governance/guardian-state.service";
import { MetricsService } from "../metrics/metrics.service";
import { FeatureFlagService } from "./feature-flag.service";
import { InMemoryFlagBus } from "./flag-bus";
import { bucketFor, evaluateFlag } from "./flag-evaluator";

/** Minimal in-memory stand-in for the Prisma models the flag service touches. */
function fakePrisma() {
  const flags = new Map<string, any>();
  const requests = new Map<string, any>();
  const audit: any[] = [];
  let down = false;
  let seq = 0;
  const client: any = {
    audit,
    setDown: (value: boolean) => (down = value),
    featureFlag: {
      findMany: async () => {
        if (down) throw new Error("db down");
        return [...flags.values()];
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = flags.get(where.key);
        const row = existing
          ? { ...existing, ...update, version: existing.version + 1, updatedAt: new Date() }
          : { ...create, version: 1, updatedAt: new Date() };
        flags.set(where.key, row);
        return row;
      },
    },
    flagChangeRequest: {
      create: async ({ data }: any) => {
        const row = { id: `req-${++seq}`, status: "pending", ...data };
        requests.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => requests.get(where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = requests.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    adminAuditLog: { create: async ({ data }: any) => audit.push(data) },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(client),
  };
  return client;
}

function config(overrides: { nodeEnv?: string; onchainDryRun?: boolean; overrides?: string } = {}) {
  const values: Record<string, unknown> = {
    nodeEnv: overrides.nodeEnv ?? "test",
    onchainDryRun: overrides.onchainDryRun ?? true,
    onchainIntentsEnabled: false,
    redisUrl: "redis://localhost:6379",
    flags: { pubsub: "memory", refreshMs: 60_000, overrides: overrides.overrides ?? "" },
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

const alice = { id: "alice", role: "admin" as const };
const bob = { id: "bob", role: "admin" as const };

async function makeService(opts: {
  prisma?: any;
  bus?: InMemoryFlagBus;
  cfg?: Parameters<typeof config>[0];
  guardian?: GuardianStateService;
  metrics?: MetricsService;
} = {}) {
  const prisma = opts.prisma ?? fakePrisma();
  const service = new FeatureFlagService(
    config(opts.cfg),
    prisma as PrismaService,
    new AdminAuditService(prisma as PrismaService),
    opts.metrics,
    opts.guardian,
    opts.bus ?? new InMemoryFlagBus(),
  );
  await service.onModuleInit();
  return { service, prisma };
}

describe("flag evaluator targeting rules", () => {
  it("matches solver allowlist and chain rules, first match wins", () => {
    const state = {
      defaultValue: true,
      rules: [
        { value: false, solvers: ["GSOLVER1"], chains: ["stellar"] },
        { value: false, chains: ["base"] },
      ],
    };
    expect(evaluateFlag("f", state, { solver: "GSOLVER1", chain: "stellar" })).toMatchObject({
      value: false,
      ruleIndex: 0,
      reason: "TARGETING_MATCH",
    });
    expect(evaluateFlag("f", state, { solver: "GSOLVER1", chain: "ethereum" })).toMatchObject({
      value: true,
      reason: "DEFAULT",
    });
    expect(evaluateFlag("f", state, { solver: "GOTHER", chain: "base" }).ruleIndex).toBe(1);
  });

  it("buckets percentage rollouts deterministically and roughly proportionally", () => {
    const state = { defaultValue: false, rules: [{ value: true, percentage: 25 }] };
    const keys = Array.from({ length: 2000 }, (_, i) => `intent-${i}`);
    const enabled = keys.filter((k) => evaluateFlag("f", state, { targetingKey: k }).value).length;
    expect(enabled / keys.length).toBeGreaterThan(0.2);
    expect(enabled / keys.length).toBeLessThan(0.3);
    expect(evaluateFlag("f", state, { targetingKey: "intent-7" })).toEqual(
      evaluateFlag("f", state, { targetingKey: "intent-7" }),
    );
    expect(bucketFor("f", "intent-7")).toBe(bucketFor("f", "intent-7"));
  });

  it("skips percentage rules without a targeting key", () => {
    const state = { defaultValue: false, rules: [{ value: true, percentage: 100 }] };
    expect(evaluateFlag("f", state, {}).value).toBe(false);
  });
});

describe("FeatureFlagService", () => {
  it("falls back to the env default when the flag has no stored state", async () => {
    const { service } = await makeService({ cfg: { onchainDryRun: false } });
    expect(await service.getBooleanValue("onchain-dry-run")).toBe(false);
  });

  it("applies an audited update and evaluates it with targeting", async () => {
    const { service, prisma } = await makeService();
    const result = await service.update(
      "onchain-intents-enabled",
      { defaultValue: false, rules: [{ value: true, chains: ["stellar"] }] },
      alice,
      "stage stellar",
    );

    expect(result.status).toBe("applied");
    expect(await service.getBooleanValue("onchain-intents-enabled", { chain: "stellar" })).toBe(true);
    expect(await service.getBooleanValue("onchain-intents-enabled", { chain: "base" })).toBe(false);
    expect(prisma.audit).toEqual([
      expect.objectContaining({ actor: "alice", action: "flag.update", target: "flag:onchain-intents-enabled" }),
    ]);
  });

  it("lets FLAG_OVERRIDES pins win over stored state", async () => {
    const { service } = await makeService({ cfg: { overrides: "onchain-intents-enabled=false" } });
    await service.update("onchain-intents-enabled", { defaultValue: true, rules: [] }, alice, "on");
    expect(await service.getBooleanValue("onchain-intents-enabled")).toBe(false);
  });

  it("serves last-known state when the database is unreachable", async () => {
    const { service, prisma } = await makeService();
    await service.update("onchain-intents-enabled", { defaultValue: true, rules: [] }, alice, "on");
    prisma.setDown(true);
    await service.reload();
    expect(await service.getBooleanValue("onchain-intents-enabled")).toBe(true);
  });

  it("keeps evaluations consistent within a request snapshot", async () => {
    const { service } = await makeService();
    await service.update("onchain-intents-enabled", { defaultValue: false, rules: [] }, alice, "off");

    const seen = await service.runWithSnapshot(async () => {
      const before = await service.getBooleanValue("onchain-intents-enabled");
      await service.update("onchain-intents-enabled", { defaultValue: true, rules: [] }, alice, "flip mid-request");
      const after = await service.getBooleanValue("onchain-intents-enabled");
      return [before, after];
    });

    expect(seen).toEqual([false, false]);
    expect(await service.getBooleanValue("onchain-intents-enabled")).toBe(true);
  });

  it("propagates changes to other instances over the bus", async () => {
    const prisma = fakePrisma();
    const bus = new InMemoryFlagBus();
    const { service: a } = await makeService({ prisma, bus });
    const { service: b } = await makeService({ prisma, bus });
    expect(await b.getBooleanValue("onchain-intents-enabled")).toBe(false);

    await a.update("onchain-intents-enabled", { defaultValue: true, rules: [] }, alice, "enable");
    await new Promise((r) => setImmediate(r));

    expect(await b.getBooleanValue("onchain-intents-enabled")).toBe(true);
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it("requires two distinct approvals to turn dry-run off in production", async () => {
    const { service, prisma } = await makeService({ cfg: { nodeEnv: "production", onchainDryRun: true } });

    const pending = await service.update("onchain-dry-run", { defaultValue: false, rules: [] }, alice, "go live");
    expect(pending.status).toBe("pending");
    expect(await service.getBooleanValue("onchain-dry-run")).toBe(true);

    const requestId = (pending as { requestId: string }).requestId;
    await expect(service.approve(requestId, alice)).rejects.toBeInstanceOf(ConflictException);

    const applied = await service.approve(requestId, bob);
    expect(applied.status).toBe("applied");
    expect(await service.getBooleanValue("onchain-dry-run")).toBe(false);
    expect(prisma.audit.map((e: any) => e.action)).toEqual(["flag.change-requested", "flag.update"]);
    await expect(service.approve(requestId, { id: "carol", role: "admin" })).rejects.toThrow();
  });

  it("applies dry-run ON in production without a second approval", async () => {
    const { service } = await makeService({ cfg: { nodeEnv: "production", onchainDryRun: false } });
    const result = await service.update("onchain-dry-run", { defaultValue: true, rules: [] }, alice, "safety");
    expect(result.status).toBe("applied");
  });

  it("rejects changes to a flag frozen by a guardian action", async () => {
    const guardian = new GuardianStateService();
    guardian.setParamFrozen("onchain-dry-run", true, { since: "t", reason: "guardian" });
    const { service } = await makeService({ guardian });
    await expect(
      service.update("onchain-dry-run", { defaultValue: true, rules: [] }, alice, "x"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("records evaluation metrics", async () => {
    const metrics = new MetricsService({ get: () => undefined } as unknown as ConfigService<AppConfig, true>);
    const { service } = await makeService({ metrics });
    await service.getBooleanValue("onchain-dry-run");
    expect(await metrics.metrics()).toContain(
      'vortex_flag_evaluations_total{flag="onchain-dry-run",value="true",reason="DEFAULT"} 1',
    );
  });
});
