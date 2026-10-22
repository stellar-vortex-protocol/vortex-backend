import { KillSwitchService } from "./killswitch.service";
import {
  InMemoryKillSwitchRepository,
  KILL_SWITCH_REPOSITORY,
  KillSwitchRepository,
} from "./killswitch.repository";
import { ConfigService } from "@nestjs/config";

function makeService(repo: KillSwitchRepository, overrides: Record<string, unknown> = {}) {
  const config = {
    get: (key: string) => {
      const values: Record<string, unknown> = {
        "killswitch.redisUrl": "",
        "killswitch.pollMs": 50,
        "killswitch.operatorToken": "secret",
        ...overrides,
      };
      return values[key];
    },
  } as unknown as ConfigService;

  return new KillSwitchService(repo, config);
}

describe("KillSwitchService", () => {
  let repo: InMemoryKillSwitchRepository;

  beforeEach(() => {
    repo = new InMemoryKillSwitchRepository();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("fail-closed behaviour", () => {
    it("blocks every write before the snapshot has loaded", () => {
      // Never call onModuleInit: simulates a replica that has not yet synced, or
      // whose initial load failed.
      const service = makeService(repo);
      expect(service.isReady()).toBe(false);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
    });

    it("stays fail-closed when the initial snapshot load throws", async () => {
      const failing: KillSwitchRepository = {
        listAll: () => {
          throw new Error("db down");
        },
        maxUpdatedAt: () => 0,
        findByTarget: () => undefined,
        activate: () => {
          throw new Error("db down");
        },
        resumeIfApproved: () => {
          throw new Error("db down");
        },
        listApprovals: () => [],
      };
      const service = makeService(failing);

      await service.onModuleInit();

      expect(service.isReady()).toBe(false);
      expect(service.isBlocked({ chain: null, token: null, operation: "create" })).toBe(true);
      await service.onModuleDestroy();
    });

    it("evaluateTarget reports paused with no match when not ready", () => {
      const service = makeService(repo);
      const decision = service.evaluateTarget({ chain: null, token: null, operation: "fill" });
      expect(decision.paused).toBe(true);
      expect(decision.matched).toBeNull();
    });
  });

  describe("pause / evaluate", () => {
    it("propagates a pause to the local snapshot immediately", async () => {
      const service = makeService(repo);
      await service.onModuleInit();

      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);

      await service.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "CHAIN_DEGRADED",
        reason: "RPC flapping",
        activatedBy: "alice",
      });

      // No polling, no redis: the caller's own replica is closed synchronously.
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      await service.onModuleDestroy();
    });

    it("scopes a pause to the requested operation only", async () => {
      const service = makeService(repo);
      await service.onModuleInit();
      await service.pause({
        scope: "operation",
        chain: "stellar",
        operation: "slash",
        reasonCode: "INCIDENT",
        reason: "registry anomaly",
        activatedBy: "alice",
      });

      expect(service.isBlocked({ chain: "stellar", token: null, operation: "slash" })).toBe(true);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);
      await service.onModuleDestroy();
    });

    it("is idempotent: pausing the same scope twice keeps one row", async () => {
      const service = makeService(repo);
      await service.onModuleInit();
      const input = {
        scope: "chain" as const,
        chain: "base",
        reasonCode: "INCIDENT",
        reason: "first",
        activatedBy: "alice",
      };
      await service.pause(input);
      await service.pause({ ...input, reason: "second" });

      expect(repo.listAll()).toHaveLength(1);
      expect(service.evaluateTarget({ chain: "base", token: null, operation: "fill" }).matched?.reason)
        .toBe("second");
      await service.onModuleDestroy();
    });

    it("rejects a global switch that also names a chain", async () => {
      const service = makeService(repo);
      await expect(
        service.pause({
          scope: "global",
          chain: "stellar",
          reasonCode: "INCIDENT",
          reason: "bad scope",
          activatedBy: "alice",
        }),
      ).rejects.toThrow(/global kill-switch cannot specify/);
      await service.onModuleDestroy();
    });

    it("rejects an operation switch with no operation", async () => {
      const service = makeService(repo);
      await expect(
        service.pause({
          scope: "operation",
          chain: "stellar",
          reasonCode: "INCIDENT",
          reason: "bad scope",
          activatedBy: "alice",
        }),
      ).rejects.toThrow(/requires chain and operation/);
      await service.onModuleDestroy();
    });
  });

  describe("two-approval resume", () => {
    async function paused() {
      const service = makeService(repo);
      await service.onModuleInit();
      const record = await service.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "INCIDENT",
        reason: "incident",
        activatedBy: "alice",
      });
      return { service, record };
    }

    it("does not resume on the first approval", async () => {
      const { service, record } = await paused();

      const first = await service.approveResume({
        id: record.id,
        approver: "alice",
        approvalsRequired: 2,
      });

      expect(first.resumed).toBe(false);
      expect(first.approvals).toBe(1);
      expect(first.record.active).toBe(true);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      await service.onModuleDestroy();
    });

    it("resumes once a second, distinct operator approves", async () => {
      const { service, record } = await paused();

      await service.approveResume({ id: record.id, approver: "alice", approvalsRequired: 2 });
      const second = await service.approveResume({ id: record.id, approver: "bob", approvalsRequired: 2 });

      expect(second.resumed).toBe(true);
      expect(second.record.active).toBe(false);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);
      await service.onModuleDestroy();
    });

    it("one operator approving twice cannot satisfy the two-approval rule", async () => {
      const { service, record } = await paused();

      await service.approveResume({ id: record.id, approver: "alice", approvalsRequired: 2 });
      const second = await service.approveResume({ id: record.id, approver: "alice", approvalsRequired: 2 });

      expect(second.resumed).toBe(false);
      expect(second.approvals).toBe(1);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      await service.onModuleDestroy();
    });

    it("honours a raised approval requirement", async () => {
      const { service, record } = await paused();

      await service.approveResume({ id: record.id, approver: "a", approvalsRequired: 3 });
      await service.approveResume({ id: record.id, approver: "b", approvalsRequired: 3 });
      const third = await service.approveResume({ id: record.id, approver: "c", approvalsRequired: 3 });

      expect(third.resumed).toBe(true);
      await service.onModuleDestroy();
    });
  });

  describe("polling fallback", () => {
    it("picks up a change made by another replica without redis", async () => {
      // Two independent services over one shared store = two replicas.
      const replicaA = makeService(repo, { "killswitch.pollMs": 10 });
      const replicaB = makeService(repo, { "killswitch.pollMs": 10 });
      await replicaA.onModuleInit();
      await replicaB.onModuleInit();

      expect(replicaB.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);

      // Replica B pauses; replica A must learn about it from the poll alone.
      await replicaB.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "CHAIN_DEGRADED",
        reason: "flap",
        activatedBy: "bob",
      });

      // Well inside the 5 s propagation budget with a 10 ms poll interval.
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(replicaA.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      await replicaA.onModuleDestroy();
      await replicaB.onModuleDestroy();
    });

    it("keeps serving the last known snapshot when a poll throws", async () => {
      const service = makeService(repo, { "killswitch.pollMs": 10 });
      await service.onModuleInit();
      await service.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "INCIDENT",
        reason: "incident",
        activatedBy: "alice",
      });

      // Break the change probe; the cached pause must survive.
      jest.spyOn(repo, "maxUpdatedAt").mockImplementation(() => {
        throw new Error("db blip");
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Still blocked: a stale-but-known pause beats failing open.
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      await service.onModuleDestroy();
    });
  });

  describe("status", () => {
    it("reports readiness, propagation mode, and active pauses", async () => {
      const service = makeService(repo);
      await service.onModuleInit();
      await service.pause({
        scope: "token",
        chain: "stellar",
        token: "USDC",
        reasonCode: "TOKEN_DEPEGGED",
        reason: "depegged",
        activatedBy: "alice",
      });

      const status = service.status();
      expect(status.ready).toBe(true);
      expect(status.propagation).toBe("db-poll");
      expect(status.switches).toHaveLength(1);
      expect(status.switches[0]).toMatchObject({
        scope: "token",
        chain: "stellar",
        token: "USDC",
        active: true,
        reasonCode: "TOKEN_DEPEGGED",
      });
      await service.onModuleDestroy();
    });
  });

  describe("protocol_status announcement", () => {
    it("broadcasts a pause and a resume", async () => {
      const service = makeService(repo);
      await service.onModuleInit();
      const events: { type: string; action?: string }[] = [];
      service.broadcastStatus = async (event) => {
        events.push(event as { type: string; action?: string });
      };

      const record = await service.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "INCIDENT",
        reason: "incident",
        activatedBy: "alice",
      });
      expect(events[0]).toMatchObject({ type: "protocol_status", action: "paused", paused: true });

      await service.approveResume({ id: record.id, approver: "alice", approvalsRequired: 1 });
      expect(events[1]).toMatchObject({ type: "protocol_status", action: "resumed", paused: false });

      await service.onModuleDestroy();
    });

    it("does not fail the pause when the broadcast throws", async () => {
      const service = makeService(repo);
      await service.onModuleInit();
      service.broadcastStatus = async () => {
        throw new Error("ws down");
      };

      const record = await service.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "INCIDENT",
        reason: "incident",
        activatedBy: "alice",
      });

      expect(record.active).toBe(true);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      await service.onModuleDestroy();
    });
  });

  describe("scheduled maintenance windows", () => {
    const base = {
      scope: "chain" as const,
      chain: "stellar",
      reasonCode: "MAINTENANCE",
      reason: "planned migration",
      activatedBy: "alice",
    };

    it("activates a scheduled pause once scheduledAt is due", async () => {
      jest.useFakeTimers();
      const service = makeService(repo);
      await service.onModuleInit();

      const scheduledAt = Date.now() + 60_000;
      const autoResumeAt = scheduledAt + 30 * 60_000;
      const record = await service.schedule({
        ...base,
        scheduledAt,
        autoResumeAt,
      });

      // Not yet due: nothing is paused.
      expect(record.active).toBe(false);
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);

      jest.setSystemTime(scheduledAt + 1);
      await service.runScheduledTransitions();

      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);
      const stored = repo.listAll().find((row) => row.id === record.id);
      expect(stored?.active).toBe(true);
      await service.onModuleDestroy();
    });

    it("auto-resumes at autoResumeAt without two-operator approval", async () => {
      jest.useFakeTimers();
      const service = makeService(repo);
      await service.onModuleInit();

      const scheduledAt = Date.now() + 60_000;
      const autoResumeAt = scheduledAt + 30 * 60_000;
      const record = await service.schedule({ ...base, scheduledAt, autoResumeAt });

      jest.setSystemTime(scheduledAt + 1);
      await service.runScheduledTransitions();
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);

      jest.setSystemTime(autoResumeAt + 1);
      await service.runScheduledTransitions();

      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);
      const stored = repo.listAll().find((row) => row.id === record.id);
      expect(stored?.active).toBe(false);
      expect(repo.listApprovals(record.id)).toHaveLength(0);
      await service.onModuleDestroy();
    });

    it("is idempotent when two replicas tick the same due window", async () => {
      jest.useFakeTimers();
      const replicaA = makeService(repo);
      const replicaB = makeService(repo);
      await replicaA.onModuleInit();
      await replicaB.onModuleInit();

      const scheduledAt = Date.now() + 60_000;
      const autoResumeAt = scheduledAt + 30 * 60_000;
      const record = await replicaA.schedule({ ...base, scheduledAt, autoResumeAt });

      jest.setSystemTime(scheduledAt + 1);
      await Promise.all([
        replicaA.runScheduledTransitions(),
        replicaB.runScheduledTransitions(),
      ]);

      // Exactly one row, still active, no duplicate transitions.
      expect(repo.listAll().filter((row) => row.id === record.id)).toHaveLength(1);
      expect(repo.listAll().find((row) => row.id === record.id)?.active).toBe(true);

      jest.setSystemTime(autoResumeAt + 1);
      await Promise.all([
        replicaA.runScheduledTransitions(),
        replicaB.runScheduledTransitions(),
      ]);

      expect(repo.listAll().find((row) => row.id === record.id)?.active).toBe(false);
      await replicaA.onModuleDestroy();
      await replicaB.onModuleDestroy();
    });

    it("skips cleanly when an operator already resumed the scope", async () => {
      jest.useFakeTimers();
      const service = makeService(repo);
      await service.onModuleInit();

      const scheduledAt = Date.now() + 60_000;
      const autoResumeAt = scheduledAt + 30 * 60_000;
      const record = await service.schedule({ ...base, scheduledAt, autoResumeAt });

      jest.setSystemTime(scheduledAt + 1);
      await service.runScheduledTransitions();
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(true);

      // Operator resumes manually before the scheduled auto-resume fires.
      await service.approveResume({ id: record.id, approver: "alice", approvalsRequired: 1 });
      await service.approveResume({ id: record.id, approver: "bob", approvalsRequired: 1 });
      expect(service.isBlocked({ chain: "stellar", token: null, operation: "fill" })).toBe(false);

      // The scheduled job must not throw and must leave the resumed row alone.
      jest.setSystemTime(autoResumeAt + 1);
      await expect(service.runScheduledTransitions()).resolves.toBeUndefined();
      expect(repo.listAll().find((row) => row.id === record.id)?.active).toBe(false);
      await service.onModuleDestroy();
    });

    it("surfaces upcoming and active scheduled windows in status()", async () => {
      jest.useFakeTimers();
      const service = makeService(repo);
      await service.onModuleInit();

      const scheduledAt = Date.now() + 60_000;
      const autoResumeAt = scheduledAt + 30 * 60_000;
      await service.schedule({ ...base, scheduledAt, autoResumeAt });

      const upcoming = service.status();
      expect(upcoming.scheduled).toHaveLength(1);
      expect(upcoming.scheduled[0]).toMatchObject({ active: false, scheduledAt, autoResumeAt });

      jest.setSystemTime(scheduledAt + 1);
      await service.runScheduledTransitions();

      const active = service.status();
      expect(active.scheduled[0]).toMatchObject({ active: true });
      await service.onModuleDestroy();
    });
  });

  describe("pause-impact preview", () => {
    it("matches evaluate() against the current snapshot without activating anything", async () => {
      const service = makeService(repo);
      await service.onModuleInit();
      await service.pause({
        scope: "chain",
        chain: "stellar",
        reasonCode: "CHAIN_DEGRADED",
        reason: "flapping",
        activatedBy: "alice",
      });

      const activateSpy = jest.spyOn(repo, "activate");
      const target = { chain: "stellar", token: null, operation: "fill" as const };

      const preview = await service.preview({
        scope: "operation",
        chain: "stellar",
        operation: "fill",
      });

      // The preview's matching must agree with evaluate()'s own logic.
      const decision = service.evaluateTarget(target);
      expect(preview.paused).toBe(decision.paused);
      expect(preview.matched?.id).toBe(decision.matched?.id);
      expect(preview.matchedChain).toBe(decision.matchedChain);

      // Read-only: no repository write occurred.
      expect(activateSpy).not.toHaveBeenCalled();
      expect(repo.listAll()).toHaveLength(1);
      await service.onModuleDestroy();
    });
  });

  describe("repository token", () => {
    it("is exported for injection", () => {
      expect(typeof KILL_SWITCH_REPOSITORY).toBe("symbol");
    });
  });
});
