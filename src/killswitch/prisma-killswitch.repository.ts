import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  ActivateInput,
  KillSwitchRecord,
  KillSwitchRepository,
} from "./killswitch.repository";
import { KillSwitchOperation, KillSwitchScope, scopeKey } from "./killswitch.types";

/** Shape the mapping needs, kept loose so the Prisma enum types line up. */
interface KillSwitchRow {
  id: string;
  scope: KillSwitchScope;
  chain: string | null;
  token: string | null;
  operation: KillSwitchOperation | null;
  active: boolean;
  reasonCode: string;
  reason: string;
  activatedBy: string;
  updatedAt: number;
  approvalsRequired: number;
  approvals?: { approver: string }[];
}

/** `include` used everywhere a record needs its approvers. */
const WITH_APPROVALS = { approvals: { select: { approver: true } } } as const;

/**
 * Prisma-backed adapter (staging/production).
 *
 * Resume runs in a transaction that locks the row before counting approvers.
 * Without the lock two concurrent approvals could each observe a count of 1 and
 * both bail, stranding the switch; or a fresh pause could interleave between the
 * count and the write and be silently undone.
 */
@Injectable()
export class PrismaKillSwitchRepository implements KillSwitchRepository {
  constructor(private readonly prisma: PrismaService) {}

  private static toRecord(row: KillSwitchRow): KillSwitchRecord {
    return {
      id: row.id,
      scope: row.scope,
      chain: row.chain,
      token: row.token,
      operation: row.operation,
      active: row.active,
      reasonCode: row.reasonCode,
      reason: row.reason,
      activatedBy: row.activatedBy,
      updatedAt: row.updatedAt,
      approvalsRequired: row.approvalsRequired,
      approvers: (row.approvals ?? []).map((approval) => approval.approver),
    };
  }

  async listAll(): Promise<KillSwitchRecord[]> {
    const rows = await this.prisma.killSwitch.findMany({ include: WITH_APPROVALS });
    return rows.map((row) => PrismaKillSwitchRepository.toRecord(row));
  }

  async maxUpdatedAt(): Promise<number> {
    const row = await this.prisma.killSwitch.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    return row?.updatedAt ?? 0;
  }

  async findByTarget(
    scope: KillSwitchScope,
    chain: string | null,
    token: string | null,
    operation: KillSwitchOperation | null,
  ): Promise<KillSwitchRecord | undefined> {
    const row = await this.prisma.killSwitch.findUnique({
      where: { scopeKey: scopeKey({ scope, chain, token, operation }) },
      include: WITH_APPROVALS,
    });
    return row ? PrismaKillSwitchRepository.toRecord(row) : undefined;
  }

  /**
   * Upsert on the scope key. A re-pause clears stale approvals: a switch that
   * was resumed and then re-paused must not inherit the previous resume's
   * sign-off, or two leftover approvals would let the next resume skip review.
   */
  async activate(input: ActivateInput): Promise<KillSwitchRecord> {
    const key = {
      scopeKey: scopeKey(input),
      scope: input.scope,
      chain: input.chain,
      token: input.token,
      operation: input.operation,
    };

    const row = await this.prisma.killSwitch.upsert({
      where: { scopeKey: key.scopeKey },
      create: {
        ...key,
        active: true,
        reasonCode: input.reasonCode,
        reason: input.reason,
        activatedBy: input.activatedBy,
        updatedAt: input.now,
        createdAt: input.now,
        approvalsRequired: 2,
      },
      update: {
        active: true,
        reasonCode: input.reasonCode,
        reason: input.reason,
        activatedBy: input.activatedBy,
        updatedAt: input.now,
        approvals: { deleteMany: {} },
      },
      include: WITH_APPROVALS,
    });

    return PrismaKillSwitchRepository.toRecord(row);
  }

  async resumeIfApproved(
    id: string,
    approver: string,
    approvalsRequired: number,
    note: string | undefined,
    now: number,
  ): Promise<KillSwitchRecord> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the row for the duration of count-then-write.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM kill_switches WHERE id = ${id} FOR UPDATE
      `;
      if (locked.length === 0) throw new Error(`KillSwitch ${id} not found`);

      const row = await tx.killSwitch.findUniqueOrThrow({ where: { id } });
      const record = PrismaKillSwitchRepository.toRecord(row as KillSwitchRow);

      if (!record.active) return record;

      // Idempotent per approver; the unique key would reject a second insert.
      await tx.killSwitchApproval.upsert({
        where: { killSwitchId_approver: { killSwitchId: id, approver } },
        create: { killSwitchId: id, approver, approvedAt: now, note },
        update: { note },
      });

      const approvals = await tx.killSwitchApproval.count({ where: { killSwitchId: id } });
      if (approvals < approvalsRequired) {
        return { ...record, approvers: record.approvers };
      }

      const resumed = await tx.killSwitch.update({
        where: { id },
        data: {
          active: false,
          updatedAt: now,
          lastResumedAt: now,
          approvals: { deleteMany: {} },
        },
      });

      return PrismaKillSwitchRepository.toRecord(resumed as KillSwitchRow);
    });
  }

  async listApprovals(id: string): Promise<string[]> {
    const rows = await this.prisma.killSwitchApproval.findMany({
      where: { killSwitchId: id },
      select: { approver: true },
    });
    return rows.map((row) => row.approver);
  }
}
