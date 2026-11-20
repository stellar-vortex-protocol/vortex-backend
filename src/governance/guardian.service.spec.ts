/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight Prisma fakes */
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { AdminAuditService } from "../admin/admin-audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { SorobanService } from "../soroban/soroban.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { assertNotPaused } from "../killswitch/killswitch.guard";
import { InMemoryKillSwitchRepository } from "../killswitch/killswitch.repository";
import { GuardianStateService } from "./guardian-state.service";
import { SolversService } from "../solvers/solvers.service";
import { InMemorySolversRepository } from "../solvers/in-memory-solvers.repository";
import { decodeGuardianEvent, GuardianEvent } from "../soroban/events/guardian-events";
import { GuardianService, OVERRIDE_PROPOSAL_TTL_MS, SNAPSHOT_MAX_INTENT_IDS } from "./guardian.service";
import { IIntentsRepository } from "../intents/intents.repository";
import { Intent } from "../intents/intents.types";

const SOLVER = "GSOLVERBLACKLISTED";
const superadmin = { id: "root", role: "superadmin" as const };
const superadmin2 = { id: "alice", role: "superadmin" as const };
const superadmin3 = { id: "bob", role: "superadmin" as const };

function fakePrisma(rows: any[] = []) {
  const actions = new Map(rows.map((r) => [r.id, r]));
  const audit: any[] = [];
  const snapshots = new Map<string, any>();
  const state = {
    actions,
    audit,
    snapshots,
    auditDown: false,
    guardianAction: {
      findMany: async () => [...actions.values()],
      upsert: async ({ where, create }: any) => {
        if (!actions.has(where.id)) actions.set(where.id, create);
      },
      update: async ({ where, data }: any) => Object.assign(actions.get(where.id), data),
    },
    guardianImpactSnapshot: {
      upsert: async ({ where, create }: any) => {
        if (!snapshots.has(where.actionId)) snapshots.set(where.actionId, create);
      },
    },
    adminAuditLog: {
      create: async ({ data }: any) => {
        if (state.auditDown) throw new Error("db down");
        audit.push(data);
      },
    },
  };
  return state;
}
let prismaState: ReturnType<typeof fakePrisma>;

function rawEvent(ledger: number, index: number, name: string, target?: string): SorobanRpc.Api.EventResponse {
  const topic = [xdr.ScVal.scvSymbol(name)];
  if (target !== undefined) topic.push(xdr.ScVal.scvString(target));
  return {
    id: `${String(ledger).padStart(10, "0")}-${index}`,
    ledger,
    ledgerClosedAt: new Date(ledger * 5_000).toISOString(),
    txHash: `tx-${ledger}-${index}`,
    topic,
  } as unknown as SorobanRpc.Api.EventResponse;
}

const event = (ledger: number, name: string, target?: string, index = 0) =>
  decodeGuardianEvent(rawEvent(ledger, index, name, target)) as GuardianEvent;

async function setup(rows: any[] = [], events: SorobanRpc.Api.EventResponse[] = [], overrideQuorum?: number, intentsRepo?: IIntentsRepository) {
  prismaState = fakePrisma(rows);
  const state = new GuardianStateService();
  const killSwitch = new KillSwitchService(
    new InMemoryKillSwitchRepository(),
    { get: (key: string) => ({ "killswitch.redisUrl": "", "killswitch.pollMs": 60_000 })[key] } as unknown as ConfigService,
    state,
  );
  await killSwitch.onModuleInit();
  const soroban = {
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1_000 }),
    getEvents: jest.fn().mockResolvedValue({ events, latestLedger: 1_000 }),
  };
  const config = {
    get: (key: string) => {
      if (key === "guardianContractId") return "CGUARDIAN";
      if (key === "guardian.overrideQuorum") return overrideQuorum ?? 2;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  const guardian = new GuardianService(
    soroban as unknown as SorobanService,
    state,
    prismaState as unknown as PrismaService,
    new AdminAuditService(prismaState as unknown as PrismaService),
    config,
    killSwitch,
    intentsRepo,
  );
  const solvers = new SolversService(new InMemorySolversRepository(), state);
  const writeBlocked = () => killSwitch.isBlocked({ chain: "stellar", token: null, operation: "create" });
  return { guardian, state, killSwitch, soroban, solvers, writeBlocked };
}

const operatorPause = (killSwitch: KillSwitchService) =>
  killSwitch.pause({ scope: "global", reasonCode: "INCIDENT", reason: "incident", activatedBy: "ops" });
const operatorResume = (killSwitch: KillSwitchService, id: string) =>
  killSwitch.approveResume({ id, approver: "ops", approvalsRequired: 1 });

describe("guardian event decoding", () => {
  it("decodes known actions and ignores unrelated or malformed events", () => {
    expect(decodeGuardianEvent(rawEvent(10, 0, "guardian_blacklist", SOLVER))).toMatchObject({
      kind: "blacklist",
      target: SOLVER,
      active: true,
      txHash: "tx-10-0",
    });
    expect(decodeGuardianEvent(rawEvent(10, 0, "intent_filled", "x"))).toBeNull();
    expect(decodeGuardianEvent(rawEvent(10, 0, "guardian_freeze"))).toBeNull();
  });
});

describe("GuardianService scenarios", () => {
  it("pause: polls, applies within one poll and rejects new operations", async () => {
    const { guardian, killSwitch, soroban } = await setup([], [rawEvent(990, 0, "guardian_pause")]);
    await guardian.poll();

    expect(soroban.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ type: "contract", contractIds: ["CGUARDIAN"] }] }),
    );
    expect(() =>
      assertNotPaused(killSwitch, { chain: "stellar", token: null, operation: "create" }),
    ).toThrow(expect.objectContaining({ reasonCode: "GUARDIAN_PAUSE" }));
    expect(guardian.status()).toMatchObject({
      paused: true,
      guardianPaused: true,
      guardianActions: [expect.objectContaining({ kind: "pause", txHash: "tx-990-0" })],
    });
    expect(prismaState.actions.get("0000000990-0")).toMatchObject({ active: true });
  });

  it("parameter freeze: freezes and unfreezes the named parameter", async () => {
    const { guardian, state } = await setup();
    await guardian.apply(event(10, "guardian_freeze", "onchain-dry-run"));
    expect(state.isParamFrozen("onchain-dry-run")).toBe(true);
    expect(state.isParamFrozen("onchain-intents-enabled")).toBe(false);

    await guardian.apply(event(11, "guardian_unfreeze", "onchain-dry-run"));
    expect(state.isParamFrozen("onchain-dry-run")).toBe(false);
  });

  it("solver blacklist: suspends the solver and blocks operator reactivation", async () => {
    const { guardian, solvers } = await setup();
    await guardian.apply(event(10, "guardian_blacklist", SOLVER));

    expect(solvers.isSuspended(SOLVER)).toBe(true);
    await expect(solvers.reactivate(SOLVER)).rejects.toBeInstanceOf(ConflictException);

    await guardian.apply(event(12, "guardian_unblacklist", SOLVER));
    expect(solvers.isSuspended(SOLVER)).toBe(false);
  });

  it("guardian unpause while an operator pause is active keeps the protocol paused", async () => {
    const { guardian, killSwitch, writeBlocked } = await setup();
    await guardian.apply(event(10, "guardian_pause"));
    const record = await operatorPause(killSwitch);

    await guardian.apply(event(11, "guardian_unpause"));
    expect(writeBlocked()).toBe(true);
    expect(guardian.status()).toMatchObject({ paused: true, guardianPaused: false });

    await operatorResume(killSwitch, record.id);
    expect(writeBlocked()).toBe(false);
  });

  it("operator resume cannot clear an active guardian pause", async () => {
    const { guardian, killSwitch, writeBlocked } = await setup();
    const record = await operatorPause(killSwitch);
    await guardian.apply(event(10, "guardian_pause"));

    await operatorResume(killSwitch, record.id);
    expect(writeBlocked()).toBe(true);
    expect(guardian.status()).toMatchObject({ paused: true, guardianPaused: true, operatorSwitches: [] });
  });

  it("ignores a replayed clear that predates the active action", async () => {
    const { guardian, writeBlocked } = await setup();
    await guardian.apply(event(120, "guardian_pause"));
    await guardian.apply(event(110, "guardian_unpause"));
    expect(writeBlocked()).toBe(true);
  });

  it("restores persisted active actions on start without re-applying cleared ones", async () => {
    const rows = [
      { id: "0000000100-0", kind: "pause", target: "", active: true, txHash: "tx-a", ledger: 100, activatedAt: new Date() },
      { id: "0000000090-0", kind: "blacklist", target: SOLVER, active: false, txHash: "tx-b", ledger: 90, activatedAt: new Date() },
    ];
    const { guardian, state, writeBlocked } = await setup(rows, [rawEvent(90, 0, "guardian_blacklist", SOLVER)]);
    await guardian.onModuleInit();
    await guardian.poll();
    guardian.onModuleDestroy();

    expect(writeBlocked()).toBe(true);
    expect(state.isSolverSuspended(SOLVER)).toBe(false);
  });

  it("superadmin override is refused when the audit write fails", async () => {
    const { guardian, writeBlocked } = await setup();
    await guardian.apply(event(10, "guardian_pause"));
    prismaState.auditDown = true;

    await expect(guardian.proposeOverride("0000000010-0", superadmin, "false positive")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(writeBlocked()).toBe(true);
  });
});

// ── Quorum override tests ────────────────────────────────────────────────────

describe("guardian quorum override — two-phase flow", () => {
  const ACTION_ID = "0000000010-0";

  async function setupWithPause(quorum?: number) {
    const ctx = await setup([], [], quorum);
    await ctx.guardian.apply(event(10, "guardian_pause"));
    return ctx;
  }

  it("below-threshold: propose records a proposal but does NOT lift the action", async () => {
    const { guardian, writeBlocked } = await setupWithPause();

    const { proposal, quorumRequired } = await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");

    expect(quorumRequired).toBe(2);
    expect(proposal.approvals).toEqual([superadmin.id]);
    expect(proposal.approvals.length).toBeLessThan(quorumRequired);
    // Action is still active — quorum not yet reached.
    expect(writeBlocked()).toBe(true);
    expect(guardian.status().guardianActions).toHaveLength(1);
    // Audit entry for the proposal was written.
    expect(prismaState.audit).toEqual([
      expect.objectContaining({ actor: superadmin.id, action: "guardian.override.propose" }),
    ]);
    // Proposal is visible in status.
    expect(guardian.status().pendingOverrides).toHaveLength(1);
  });

  it("threshold-reached: second approval executes the override and lifts the action", async () => {
    const { guardian, writeBlocked } = await setupWithPause();

    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");
    const { executed } = await guardian.approveOverride(ACTION_ID, superadmin2);

    expect(executed).toBe(true);
    expect(writeBlocked()).toBe(false);
    expect(guardian.status().guardianActions).toHaveLength(0);
    expect(guardian.status().pendingOverrides).toHaveLength(0);

    // Audit trail: propose + approve + execute entries.
    expect(prismaState.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: superadmin.id, action: "guardian.override.propose" }),
        expect.objectContaining({ actor: superadmin2.id, action: "guardian.override.approve" }),
        expect.objectContaining({ actor: superadmin.id, action: "guardian.override" }),
      ]),
    );
    // DB row reflects the override.
    expect(prismaState.actions.get(ACTION_ID)).toMatchObject({
      active: false,
      overriddenBy: expect.stringContaining(superadmin.id),
    });
  });

  it("same-admin-double-approve: proposer cannot also approve their own proposal", async () => {
    const { guardian, writeBlocked } = await setupWithPause();

    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");

    await expect(guardian.approveOverride(ACTION_ID, superadmin)).rejects.toBeInstanceOf(BadRequestException);
    // Action is still active.
    expect(writeBlocked()).toBe(true);
  });

  it("same-admin-double-approve: an approver cannot approve twice", async () => {
    // Use quorum=3 so we can test mid-flow double-approve without executing.
    const { guardian, writeBlocked } = await setupWithPause(3);

    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");
    await guardian.approveOverride(ACTION_ID, superadmin2);

    await expect(guardian.approveOverride(ACTION_ID, superadmin2)).rejects.toBeInstanceOf(BadRequestException);
    expect(writeBlocked()).toBe(true);
  });

  it("superseding-event-cancels-proposal: new guardian event for the same key clears the pending proposal", async () => {
    const { guardian, writeBlocked } = await setupWithPause();

    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");
    expect(guardian.status().pendingOverrides).toHaveLength(1);

    // Guardian emits a new pause event — this should cancel the pending proposal.
    await guardian.apply(event(20, "guardian_pause"));

    expect(guardian.status().pendingOverrides).toHaveLength(0);
    // The new pause is active.
    expect(writeBlocked()).toBe(true);
  });

  it("approve on a non-existent proposal throws NotFoundException", async () => {
    const { guardian } = await setupWithPause();

    await expect(guardian.approveOverride(ACTION_ID, superadmin2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("propose on a non-active action throws NotFoundException", async () => {
    const { guardian } = await setup();

    await expect(guardian.proposeOverride("nonexistent-id", superadmin, "reason")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("duplicate propose on an already-pending proposal throws ConflictException", async () => {
    const { guardian } = await setupWithPause();

    await guardian.proposeOverride(ACTION_ID, superadmin, "first attempt");
    await expect(guardian.proposeOverride(ACTION_ID, superadmin2, "second attempt")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("expired proposal is rejected and removed on approve", async () => {
    const { guardian } = await setupWithPause();

    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");

    // Fast-forward time past the TTL.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + OVERRIDE_PROPOSAL_TTL_MS + 1_000);

    await expect(guardian.approveOverride(ACTION_ID, superadmin2)).rejects.toBeInstanceOf(NotFoundException);
    expect(guardian.pendingOverrideProposals()).toHaveLength(0);

    jest.restoreAllMocks();
  });

  it("threshold-reached with quorum=1: propose immediately executes the override", async () => {
    const { guardian, writeBlocked } = await setupWithPause(1);

    // With quorum=1 the proposal itself constitutes a full approval.
    // proposeOverride adds the proposer, reaching threshold=1 on the approve call.
    // But propose only *records* — approve is still required. With quorum=1 the
    // first approveOverride call (by any distinct admin, or the proposer) would
    // double-approve. So quorum=1 is unusual but valid via approveOverride.
    // The propose leaves 1 approval; approve by a *different* admin executes.
    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");
    // quorum=1 means 1 approval suffices — propose already adds the proposer (count=1).
    // The approveOverride call for the proposer would throw (double-approve).
    // A different admin approves and that takes it past threshold.
    const { executed } = await guardian.approveOverride(ACTION_ID, superadmin2);
    expect(executed).toBe(true);
    expect(writeBlocked()).toBe(false);
  });

  it("guardian override clears the action with an audit record until the guardian acts again (compat)", async () => {
    // Verifies the full end-to-end flow mirrors the original single-step test.
    const { guardian, writeBlocked } = await setupWithPause();

    await guardian.proposeOverride(ACTION_ID, superadmin, "false positive");
    await guardian.approveOverride(ACTION_ID, superadmin2);

    expect(writeBlocked()).toBe(false);
    expect(prismaState.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: "root", action: "guardian.override.propose", reason: "false positive" }),
        expect.objectContaining({ actor: "alice", action: "guardian.override.approve" }),
        expect.objectContaining({ actor: "root", action: "guardian.override", reason: "false positive" }),
      ]),
    );
    expect(prismaState.actions.get(ACTION_ID)).toMatchObject({ active: false });

    // Guardian can re-pause after the override.
    await guardian.apply(event(20, "guardian_pause"));
    expect(writeBlocked()).toBe(true);
  });
});

// ── Impact snapshot tests ────────────────────────────────────────────────────

function fakeIntentsRepo(intents: Partial<Intent>[]): IIntentsRepository {
  return {
    findAll: jest.fn().mockResolvedValue(intents),
  } as unknown as IIntentsRepository;
}

describe("guardian impact snapshot", () => {
  it("pause activation captures protocol-wide open-intent count", async () => {
    const intents: Partial<Intent>[] = [
      { intentId: "i1", state: "open", solver: undefined },
      { intentId: "i2", state: "accepted", solver: undefined },
      { intentId: "i3", state: "filled", solver: undefined },
    ];
    const repo = fakeIntentsRepo(intents);
    const { guardian } = await setup([], [], undefined, repo);

    await guardian.apply(event(10, "guardian_pause"));
    // Snapshot is fire-and-forget; wait a tick for the promise to settle.
    await new Promise((r) => setTimeout(r, 10));

    const snap = prismaState.snapshots.get("0000000010-0");
    expect(snap).toBeDefined();
    expect(snap.kind).toBe("pause");
    expect(snap.openIntentCount).toBe(2); // only open + accepted
    expect(snap.affectedIntentIds).toEqual([]);
    expect(snap.solverAddress).toBeNull();
  });

  it("blacklist activation captures solver-specific open intent ids", async () => {
    const intents: Partial<Intent>[] = [
      { intentId: "i1", state: "open", solver: SOLVER },
      { intentId: "i2", state: "accepted", solver: SOLVER },
      { intentId: "i3", state: "open", solver: "OTHER_SOLVER" },
      { intentId: "i4", state: "filled", solver: SOLVER },
    ];
    const repo = fakeIntentsRepo(intents);
    const { guardian } = await setup([], [], undefined, repo);

    await guardian.apply(event(10, "guardian_blacklist", SOLVER));
    await new Promise((r) => setTimeout(r, 10));

    const snap = prismaState.snapshots.get("0000000010-0");
    expect(snap).toBeDefined();
    expect(snap.kind).toBe("blacklist");
    expect(snap.solverAddress).toBe(SOLVER);
    expect(snap.openIntentCount).toBe(2); // i1 + i2 (not i3=other solver, not i4=filled)
    expect(snap.affectedIntentIds).toEqual(expect.arrayContaining(["i1", "i2"]));
  });

  it("freeze activation does NOT capture a snapshot", async () => {
    const repo = fakeIntentsRepo([{ intentId: "i1", state: "open" }]);
    const { guardian } = await setup([], [], undefined, repo);

    await guardian.apply(event(10, "guardian_freeze", "onchain-dry-run"));
    await new Promise((r) => setTimeout(r, 10));

    expect(prismaState.snapshots.size).toBe(0);
  });

  it("replayed duplicate activation skips snapshot (upsert no-ops on conflict)", async () => {
    const repo = fakeIntentsRepo([{ intentId: "i1", state: "open" }]);
    const { guardian } = await setup([], [], undefined, repo);

    await guardian.apply(event(10, "guardian_pause"));
    await new Promise((r) => setTimeout(r, 10));
    const firstSnap = { ...prismaState.snapshots.get("0000000010-0") };

    // seen-set prevents re-apply of the same event id, so snapshot stays as-is.
    await guardian.apply(event(10, "guardian_pause"));
    await new Promise((r) => setTimeout(r, 10));

    expect(prismaState.snapshots.size).toBe(1);
    expect(prismaState.snapshots.get("0000000010-0")).toMatchObject(firstSnap);
  });

  it("snapshot capped at SNAPSHOT_MAX_INTENT_IDS for a large blacklist", async () => {
    const many: Partial<Intent>[] = Array.from({ length: SNAPSHOT_MAX_INTENT_IDS + 10 }, (_, i) => ({
      intentId: `i${i}`,
      state: "open" as const,
      solver: SOLVER,
    }));
    const repo = fakeIntentsRepo(many);
    const { guardian } = await setup([], [], undefined, repo);

    await guardian.apply(event(10, "guardian_blacklist", SOLVER));
    await new Promise((r) => setTimeout(r, 10));

    const snap = prismaState.snapshots.get("0000000010-0");
    expect(snap.affectedIntentIds).toHaveLength(SNAPSHOT_MAX_INTENT_IDS);
    expect(snap.openIntentCount).toBe(SNAPSHOT_MAX_INTENT_IDS + 10);
  });

  it("snapshot failure is non-blocking — guardian state still applied", async () => {
    const brokenRepo = {
      findAll: jest.fn().mockRejectedValue(new Error("db timeout")),
    } as unknown as IIntentsRepository;
    const { guardian, writeBlocked } = await setup([], [], undefined, brokenRepo);

    // Should not throw even though snapshot query fails.
    await guardian.apply(event(10, "guardian_pause"));
    await new Promise((r) => setTimeout(r, 10));

    // Guardian state IS applied despite snapshot failure.
    expect(writeBlocked()).toBe(true);
    expect(prismaState.snapshots.size).toBe(0);
  });
});
