import { Injectable } from "@nestjs/common";
import {
  KillSwitchOperation,
  KillSwitchScope,
  SwitchSnapshotEntry,
  scopeKey,
} from "./killswitch.types";

/**
 * NestJS injection token for the kill-switch repository.
 *
 * Mirrors the INTENTS_REPOSITORY / SOLVERS_REPOSITORY convention so the
 * persistence backend can be swapped (in-memory for dev/test, Prisma for
 * staging/production) without touching KillSwitchService.
 */
export const KILL_SWITCH_REPOSITORY = Symbol("KILL_SWITCH_REPOSITORY");

/** A switch row plus the approval bookkeeping the service needs. */
export interface KillSwitchRecord extends SwitchSnapshotEntry {
  id: string;
  approvalsRequired: number;
  approvers: string[];
}

export interface KillSwitchRepository {
  /** Full snapshot of every switch, used to seed/refresh the local cache. */
  listAll(): KillSwitchRecord[] | Promise<KillSwitchRecord[]>;

  /**
   * Cheap change probe: the newest `updated_at` across all switches, or 0 when
   * there are none. The polling fallback compares this against its last-seen
   * value and only pays for a full reload when it moves.
   */
  maxUpdatedAt(): number | Promise<number>;

  findByTarget(
    scope: KillSwitchScope,
    chain: string | null,
    token: string | null,
    operation: KillSwitchOperation | null,
  ): KillSwitchRecord | undefined | Promise<KillSwitchRecord | undefined>;
  /**
   * Create the row if absent, otherwise transition it to active. Idempotent:
   * calling pause twice is not an error and does not duplicate the row.
   */
  activate(input: ActivateInput): KillSwitchRecord | Promise<KillSwitchRecord>;

  /**
   * Record an approval, and resume only once `approvalsRequired` DISTINCT
   * approvers have been recorded. Returns the row either way; the caller reads
   * `active` to see whether the resume actually happened.
   */
  resumeIfApproved(
    id: string,
    approver: string,
    approvalsRequired: number,
    note: string | undefined,
    now: number,
  ): KillSwitchRecord | Promise<KillSwitchRecord>;

  /** Approvers recorded so far, for the operator status endpoint. */
  listApprovals(id: string): string[] | Promise<string[]>;
}

export interface ActivateInput {
  scope: KillSwitchScope;
  chain: string | null;
  token: string | null;
  operation: KillSwitchOperation | null;
  reasonCode: string;
  reason: string;
  activatedBy: string;
  /** Unix epoch ms; defaults to now in the adapters. */
  now: number;
}

/**
 * In-memory adapter. Used by dev and the unit tests.
 *
 * `list` is the source of truth. `maxUpdatedAt` is a plain reduce, which is
 * exactly the guarantee the polling loop needs: it is monotonic while a switch
 * exists, so a pause that reuses an already-active row still bumps the value
 * and is picked up on the next poll.
 */
@Injectable()
export class InMemoryKillSwitchRepository implements KillSwitchRepository {
  private readonly list = new Map<string, KillSwitchRecord>();

  private static key(input: {
    scope: KillSwitchScope;
    chain: string | null;
    token: string | null;
    operation: KillSwitchOperation | null;
  }): string {
    return scopeKey(input);
  }

  listAll(): KillSwitchRecord[] {
    return [...this.list.values()];
  }

  maxUpdatedAt(): number {
    let max = 0;
    for (const record of this.list.values()) {
      if (record.updatedAt > max) max = record.updatedAt;
    }
    return max;
  }

  findByTarget(
    scope: KillSwitchScope,
    chain: string | null,
    token: string | null,
    operation: KillSwitchOperation | null,
  ): KillSwitchRecord | undefined {
    return this.list.get(InMemoryKillSwitchRepository.key({ scope, chain, token, operation }));
  }

  activate(input: ActivateInput): KillSwitchRecord {
    const key = InMemoryKillSwitchRepository.key(input);
    const existing = this.list.get(key);

    if (existing) {
      existing.active = true;
      existing.reasonCode = input.reasonCode;
      existing.reason = input.reason;
      existing.activatedBy = input.activatedBy;
      // A pause is a new decision requiring fresh consent. Any approval left
      // over from the previous pause of this scope must be discarded, or one
      // operator could resume the second pause on the strength of the first —
      // and a single leftover approval would mean the *next* resume needs only
      // one more signature. The Prisma adapter clears these in the same
      // upsert; this keeps the two adapters behaviourally identical.
      existing.approvers = [];
      // Bump even when already active: the operator may be escalating the
      // reason, and the poller keys off this value.
      existing.updatedAt = input.now;
      return existing;
    }

    const record: KillSwitchRecord = {
      id: `ks_${key}`,
      scope: input.scope,
      chain: input.chain,
      token: input.token,
      operation: input.operation,
      active: true,
      reasonCode: input.reasonCode,
      reason: input.reason,
      activatedBy: input.activatedBy,
      updatedAt: input.now,
      approvalsRequired: 2,
      approvers: [],
    };
    this.list.set(key, record);
    return record;
  }

  resumeIfApproved(
    id: string,
    approver: string,
    approvalsRequired: number,
    note: string | undefined,
    now: number,
  ): KillSwitchRecord {
    const record = [...this.list.values()].find((candidate) => candidate.id === id);
    if (!record) throw new Error(`KillSwitch ${id} not found`);
    if (!record.active) return record;

    // A single operator approving twice must not satisfy the two-approval rule.
    if (!record.approvers.includes(approver)) record.approvers.push(approver);
    if (record.approvers.length < approvalsRequired) return record;

    record.active = false;
    record.updatedAt = now;
    record.approvers = [];
    void note;
    return record;
  }

  listApprovals(id: string): string[] {
    const record = [...this.list.values()].find((candidate) => candidate.id === id);
    return record ? [...record.approvers] : [];
  }
}
