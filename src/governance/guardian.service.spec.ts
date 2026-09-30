/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight Prisma fakes */
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
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
import { GuardianService } from "./guardian.service";

const SOLVER = "GSOLVERBLACKLISTED";
const superadmin = { id: "root", role: "superadmin" as const };

function fakePrisma(rows: any[] = []) {
  const actions = new Map(rows.map((r) => [r.id, r]));
  const audit: any[] = [];
  const state = {
    actions,
    audit,
    auditDown: false,
    guardianAction: {
      findMany: async () => [...actions.values()],
      upsert: async ({ where, create }: any) => {
        if (!actions.has(where.id)) actions.set(where.id, create);
      },
      update: async ({ where, data }: any) => Object.assign(actions.get(where.id), data),
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

async function setup(rows: any[] = [], events: SorobanRpc.Api.EventResponse[] = []) {
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
  const config = { get: () => "CGUARDIAN" } as unknown as ConfigService<AppConfig, true>;
  const guardian = new GuardianService(
    soroban as unknown as SorobanService,
    state,
    prismaState as unknown as PrismaService,
    new AdminAuditService(prismaState as unknown as PrismaService),
    config,
    killSwitch,
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

    await expect(guardian.override("0000000010-0", superadmin, "false positive")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(writeBlocked()).toBe(true);
  });

  it("superadmin override clears the action with an audit record until the guardian acts again", async () => {
    const { guardian, writeBlocked } = await setup();
    await guardian.apply(event(10, "guardian_pause"));

    await guardian.override("0000000010-0", superadmin, "false positive");
    expect(writeBlocked()).toBe(false);
    expect(prismaState.audit).toEqual([
      expect.objectContaining({ actor: "root", action: "guardian.override", reason: "false positive" }),
    ]);
    expect(prismaState.actions.get("0000000010-0")).toMatchObject({ active: false, overriddenBy: "root" });

    await guardian.apply(event(20, "guardian_pause"));
    expect(writeBlocked()).toBe(true);
  });
});
