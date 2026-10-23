import { Injectable } from "@nestjs/common";
import {
  KillSwitchOperation,
  KillSwitchScope,
  ScheduledKillSwitchWindow,
  ScheduledWindowState,
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

  /**
   * Persist a one-shot scheduled maintenance window. The row starts in the
   * `pending` state and is picked up by the background scheduler once
   * `scheduledAt` passes.
   */
  createScheduled(
    input: CreateScheduledInput,
  ): ScheduledKillSwitchWindow | Promise<ScheduledKillSwitchWindow>;

  /**
   * Scheduled windows that are still relevant to the operator status endpoint:
   * `pending` (upcoming) and `active` (currently pausing a scope).
   */
  listScheduled(
    filter?: ListScheduledFilter,
  ): ScheduledKillSwitchWindow[] | Promise<ScheduledKillSwitchWindow[]>;

  /**
   * Atomically claim the next `pending` window whose `scheduledAt` has passed
   * and transition it to `active`. Returns the claimed window, or null when
   * there is nothing due (or another replica already claimed it).
   */
  claimDueActivation(
    now: number,
  ): ScheduledKillSwitchWindow | null | Promise<ScheduledKillSwitchWindow | null>;

  /**
   * Atomically claim the next `active` window whose `autoResumeAt` has passed
   * and transition it to `completed`. Returns the claimed window, or null when
   * there is nothing due (or another replica already claimed it).
   */
  claimDueAutoResume(
    now: number,
  ): ScheduledKillSwitchWindow | null | Promise<ScheduledKillSwitchWindow | null>;

  /**
   * Resolved (no-longer-active) switches with a non-null `resumedAt`, newest
   * first. Backs the public status-history endpoint; `since` is an inclusive
   * lower bound on `resumedAt` (unix epoch ms) and `chain` narrows to one chain.
   */
  listResolved(
    since: number | undefined,
    chain: string | undefined,
  ): KillSwitchRecord[] | Promise<KillSwitchRecord[]>;
}

export interface CreateScheduledInput {
  scope: KillSwitchScope;
  chain: string | null;
  token: string | null;
  operation: KillSwitchOperation | null;
  reasonCode: string;
  reason: string;
  scheduledBy: string;
  /** Unix epoch ms at which the pause should activate. */
  scheduledAt: number;
  /** Unix epoch ms at which the pause should auto-resume. */
  autoResumeAt: number;
  /** Unix epoch ms; defaults to now in the adapters. */
  now: number;
}

export interface ListScheduledFilter {
  /** Restrict to these states; defaults to `pending` + `active`. */
  states?: ScheduledWindowState[];
  chain?: string | null;
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
  private readonly scheduled = new Map<string, ScheduledKillSwitchWindow>();
  private scheduledSeq = 0;

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
    record.resumedAt = now;
    record.approvers = [];
    void note;
    return record;
  }

  listApprovals(id: string): string[] {
    const record = [...this.list.values()].find((candidate) => candidate.id === id);
    return record ? [...record.approvers] : [];
  }

  createScheduled(input: CreateScheduledInput): ScheduledKillSwitchWindow {
    this.scheduledSeq += 1;
    const window: ScheduledKillSwitchWindow = {
      id: `ksw_${this.scheduledSeq}`,
      scope: input.scope,
      chain: input.chain,
      token: input.token,
      operation: input.operation,
      reasonCode: input.reasonCode,
      reason: input.reason,
      scheduledBy: input.scheduledBy,
      scheduledAt: input.scheduledAt,
      autoResumeAt: input.autoResumeAt,
      state: "pending",
      activatedSwitchId: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.scheduled.set(window.id, window);
    return { ...window };
  }

  listScheduled(filter?: ListScheduledFilter): ScheduledKillSwitchWindow[] {
    const states = filter?.states ?? ["pending", "active"];
    const chain = filter?.chain;
    return [...this.scheduled.values()]
      .filter((window) => states.includes(window.state))
      .filter((window) => (chain === undefined ? true : window.chain === chain))
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map((window) => ({ ...window }));
  }

  claimDueActivation(now: number): ScheduledKillSwitchWindow | null {
    // Conditional transition: only a row still in `pending` may be claimed, so
    // a second replica (or a double-fire) sees the updated state and no-ops.
    const due = [...this.scheduled.values()]
      .filter((window) => window.state === "pending" && window.scheduledAt <= now)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
    if (!due) return null;
    due.state = "active";
    due.updatedAt = now;
    return { ...due };
  }

  claimDueAutoResume(now: number): ScheduledKillSwitchWindow | null {
    const due = [...this.scheduled.values()]
      .filter((window) => window.state === "active" && window.autoResumeAt <= now)
      .sort((a, b) => a.autoResumeAt - b.autoResumeAt)[0];
    if (!due) return null;
    due.state = "completed";
    due.updatedAt = now;
    return { ...due };
  }

  listResolved(since: number | undefined, chain: string | undefined): KillSwitchRecord[] {
    return [...this.list.values()]
      .filter((record) => !record.active && record.resumedAt != null)
      .filter((record) => (since === undefined ? true : (record.resumedAt as number) >= since))
      .filter((record) => (chain === undefined ? true : record.chain === chain))
      .sort((a, b) => (b.resumedAt as number) - (a.resumedAt as number))
      .map((record) => ({ ...record }));
  }
}
