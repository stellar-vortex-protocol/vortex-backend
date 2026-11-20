import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { AdminAuditService } from "../admin/admin-audit.service";
import { AdminPrincipal } from "../admin/admin-auth";
import { SorobanService } from "../soroban/soroban.service";
import { parseEventIndex } from "../soroban/event-ingestion.service";
import { decodeGuardianEvent, GuardianEvent } from "../soroban/events/guardian-events";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { ALL_PARAMS, GuardianStateService, StateRef } from "./guardian-state.service";
import { INTENTS_REPOSITORY, IIntentsRepository } from "../intents/intents.repository";

/** Guardian actions are applied within one poll of this interval. */
export const GUARDIAN_POLL_INTERVAL_MS = 10_000;
/** On start, replay this many ledgers (~24 h at 5 s) to catch actions missed while down. */
export const GUARDIAN_LOOKBACK_LEDGERS = 17_280;
/** Default number of distinct superadmin approvals required to execute an override. */
export const DEFAULT_OVERRIDE_QUORUM = 2;
/** Milliseconds after which an un-executed pending override proposal expires. */
export const OVERRIDE_PROPOSAL_TTL_MS = 30 * 60 * 1_000; // 30 minutes
/** Maximum number of affected intent ids stored per blacklist snapshot (keeps row size bounded). */
export const SNAPSHOT_MAX_INTENT_IDS = 500;

/** Point-in-time blast-radius snapshot captured when a guardian action activates. */
export interface GuardianImpactSnapshot {
  actionId: string;
  kind: "pause" | "blacklist";
  /** Solver address for blacklist snapshots; undefined for pause. */
  solverAddress?: string;
  /** Total protocol-wide open (open | accepted) intent count at activation. */
  openIntentCount: number;
  /** For blacklist: up to SNAPSHOT_MAX_INTENT_IDS open intent ids for the suspended solver. */
  affectedIntentIds: string[];
  capturedAt: string;
}

/** An active guardian action, as shown on the public status endpoint. */
export interface GuardianActionRecord {
  id: string;
  kind: GuardianEvent["kind"];
  target: string;
  txHash: string;
  ledger: number;
  activatedAt: string;
}

/** A pending quorum override proposal. */
export interface OverrideProposal {
  actionId: string;
  reason: string;
  proposedBy: string;
  proposedAt: number;
  /** Distinct admin ids that have approved, including the proposer. */
  approvals: string[];
  expiresAt: number;
}

const keyOf = (kind: string, target: string) => `${kind}:${target}`;

/** True when event `a` is strictly later on-chain than action `b`. */
function isAfter(a: { ledger: number; id: string }, b: { ledger: number; id: string }): boolean {
  return a.ledger !== b.ledger ? a.ledger > b.ledger : parseEventIndex(a.id) > parseEventIndex(b.id);
}

/**
 * Guardian emergency signal ingestion (issue #507).
 *
 * Polls the guardian contract and derives pause, solver-suspension and
 * parameter-freeze state ({@link GuardianStateService}) from its events. While a guardian action is active
 * it is authoritative: operators cannot clear it — only a later guardian
 * event or an audited superadmin {@link override} can.
 *
 * Every API instance polls independently so each applies an action within
 * one poll interval without cross-instance coordination.
 */
@Injectable()
export class GuardianService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GuardianService.name);
  private readonly contractId: string;
  private readonly overrideQuorum: number;
  private readonly active = new Map<string, GuardianActionRecord>();
  private readonly seen = new Set<string>();
  /** Pending quorum override proposals, keyed by actionId. */
  private readonly pendingOverrides = new Map<string, OverrideProposal>();
  private cursor?: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly soroban: SorobanService,
    private readonly state: GuardianStateService,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly killSwitch?: KillSwitchService,
    @Optional() @Inject(INTENTS_REPOSITORY) private readonly intentsRepo?: IIntentsRepository,
  ) {
    this.contractId = config.get("guardianContractId", { infer: true });
    this.overrideQuorum =
      (config as ConfigService<AppConfig, false>).get("guardian.overrideQuorum", { infer: true }) ??
      DEFAULT_OVERRIDE_QUORUM;
  }

  async onModuleInit(): Promise<void> {
    if (!this.contractId) return;
    await this.restore();
    this.timer = setInterval(() => {
      this.poll().catch((err) => this.logger.error(`[guardian] poll failed: ${(err as Error).message}`));
    }, GUARDIAN_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fetches and applies new guardian events. */
  async poll(): Promise<void> {
    if (this.cursor === undefined) {
      const latest = await this.soroban.getLatestLedger();
      this.cursor = Math.max(1, latest.sequence - GUARDIAN_LOOKBACK_LEDGERS);
    }
    const response = await this.soroban.getEvents({
      startLedger: this.cursor,
      filters: [{ type: "contract", contractIds: [this.contractId] }],
    });
    for (const raw of response.events) {
      const event = decodeGuardianEvent(raw);
      if (event) await this.apply(event);
    }
    this.cursor = response.latestLedger + 1;
  }

  /** Applies one decoded event. Idempotent per event id; stale clears are ignored. */
  async apply(event: GuardianEvent): Promise<void> {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    const key = keyOf(event.kind, event.target);
    const current = this.active.get(key);

    if (event.active) {
      if (current && !isAfter(event, current)) return;
      const record: GuardianActionRecord = {
        id: event.id,
        kind: event.kind,
        target: event.target,
        txHash: event.txHash,
        ledger: event.ledger,
        activatedAt: event.ledgerClosedAt,
      };
      this.active.set(key, record);
      // A new on-chain event for this key cancels any pending override proposal
      // — the guardian has spoken again, so the half-approved proposal is stale.
      this.cancelPendingOverrideForKey(key, `superseded by new guardian event ${event.id}`);
      this.project(record, true, "guardian action");
      await this.persist(() =>
        this.prisma.guardianAction.upsert({
          where: { id: record.id },
          create: { ...record, active: true, activatedAt: new Date(record.activatedAt) },
          update: {},
        }),
      );
      // Capture a best-effort blast-radius snapshot for pause and blacklist
      // actions only (freeze has no "affected intents" concept). Fire-and-forget:
      // a slow or failed snapshot query must never delay the guardian state taking effect.
      if (record.kind === "pause" || record.kind === "blacklist") {
        this.captureImpactSnapshot(record).catch((err) =>
          this.logger.warn(`[guardian] impact snapshot failed for ${record.id}: ${(err as Error).message}`),
        );
      }
      return;
    }

    // A clear only affects an action activated before it (replay-safe).
    if (!current || !isAfter(event, current)) return;
    this.active.delete(key);
    // A guardian-issued clear also cancels any pending proposal for this key.
    this.cancelPendingOverrideForKey(key, `guardian-issued clear tx ${event.txHash}`);
    this.project(current, false, `guardian cleared (tx ${event.txHash})`);
    await this.persist(() =>
      this.prisma.guardianAction.update({
        where: { id: current.id },
        data: { active: false, clearedAt: new Date(event.ledgerClosedAt), clearedTxHash: event.txHash },
      }),
    );
  }

  /**
   * Phase 1 — Superadmin break-glass (quorum path).
   *
   * Records a pending override proposal for `actionId`. A second (distinct)
   * superadmin must call {@link approveOverride} before the action is lifted.
   * The proposal expires after {@link OVERRIDE_PROPOSAL_TTL_MS} to prevent
   * stale half-approvals from being completed long after the incident context
   * has changed.
   *
   * Throws if:
   * - The action is not currently active.
   * - A non-expired proposal already exists for this action (idempotent retry
   *   is intentionally rejected so the proposer cannot silently restart the
   *   quorum window).
   */
  async proposeOverride(
    actionId: string,
    admin: AdminPrincipal,
    reason: string,
  ): Promise<{ proposal: OverrideProposal; quorumRequired: number }> {
    const record = [...this.active.values()].find((a) => a.id === actionId);
    if (!record) throw new NotFoundException("No active guardian action with that id");

    const existing = this.pendingOverrides.get(actionId);
    if (existing && Date.now() < existing.expiresAt) {
      throw new ConflictException(
        `An override proposal for action ${actionId} is already pending. ` +
          `Use the approve endpoint to co-sign it, or wait for it to expire.`,
      );
    }

    const now = Date.now();
    const proposal: OverrideProposal = {
      actionId,
      reason,
      proposedBy: admin.id,
      proposedAt: now,
      approvals: [admin.id],
      expiresAt: now + OVERRIDE_PROPOSAL_TTL_MS,
    };
    this.pendingOverrides.set(actionId, proposal);

    await this.audit.record({
      actor: admin.id,
      action: "guardian.override.propose",
      target: `guardian:${actionId}`,
      before: record,
      after: { proposal },
      reason,
    });

    this.logger.warn(
      `[guardian] override proposed for ${actionId} by ${admin.id} ` +
        `(${proposal.approvals.length}/${this.overrideQuorum} approvals)`,
    );
    return { proposal, quorumRequired: this.overrideQuorum };
  }

  /**
   * Phase 2 — Co-sign a pending override proposal.
   *
   * The approving admin must be distinct from every admin who has already
   * approved (including the proposer). Once the approval count reaches the
   * configured quorum the override is executed immediately.
   *
   * Returns the current proposal state. When the quorum is reached the
   * returned `executed` flag is `true` and the action has already been lifted.
   */
  async approveOverride(
    actionId: string,
    admin: AdminPrincipal,
  ): Promise<{ proposal: OverrideProposal; executed: boolean; quorumRequired: number }> {
    const proposal = this.pendingOverrides.get(actionId);
    if (!proposal) {
      throw new NotFoundException(
        `No pending override proposal for action ${actionId}. ` +
          `A superadmin must propose one first via the propose endpoint.`,
      );
    }
    if (Date.now() >= proposal.expiresAt) {
      this.pendingOverrides.delete(actionId);
      throw new NotFoundException(
        `The override proposal for action ${actionId} has expired. Please propose a new one.`,
      );
    }
    if (proposal.approvals.includes(admin.id)) {
      throw new BadRequestException(
        `Admin ${admin.id} has already approved this proposal. ` +
          `A different superadmin must provide the remaining approvals to satisfy the quorum.`,
      );
    }

    proposal.approvals.push(admin.id);

    await this.audit.record({
      actor: admin.id,
      action: "guardian.override.approve",
      target: `guardian:${actionId}`,
      after: { approvals: proposal.approvals, quorumRequired: this.overrideQuorum },
    });

    this.logger.warn(
      `[guardian] override co-signed for ${actionId} by ${admin.id} ` +
        `(${proposal.approvals.length}/${this.overrideQuorum} approvals)`,
    );

    if (proposal.approvals.length >= this.overrideQuorum) {
      await this.executeOverride(actionId, proposal);
      return { proposal, executed: true, quorumRequired: this.overrideQuorum };
    }

    return { proposal, executed: false, quorumRequired: this.overrideQuorum };
  }

  /**
   * Executes an approved override once the quorum threshold is met.
   * Separated from {@link approveOverride} so the audit write, state mutation
   * and DB update are clearly scoped to execution rather than approval.
   */
  private async executeOverride(actionId: string, proposal: OverrideProposal): Promise<GuardianActionRecord> {
    const record = [...this.active.values()].find((a) => a.id === actionId);
    if (!record) {
      this.pendingOverrides.delete(actionId);
      throw new NotFoundException("Guardian action is no longer active (may have been cleared on-chain)");
    }

    // Write the execution audit entry before mutating state.
    await this.audit.record({
      actor: proposal.proposedBy,
      action: "guardian.override",
      target: `guardian:${record.id}`,
      before: record,
      after: { approvals: proposal.approvals },
      reason: proposal.reason,
    });

    this.pendingOverrides.delete(actionId);
    this.active.delete(keyOf(record.kind, record.target));
    this.project(record, false, `quorum override by [${proposal.approvals.join(", ")}]: ${proposal.reason}`);

    await this.persist(() =>
      this.prisma.guardianAction.update({
        where: { id: record.id },
        data: { active: false, clearedAt: new Date(), overriddenBy: proposal.approvals.join(",") },
      }),
    );
    return record;
  }

  /**
   * Returns pending override proposals (non-expired) so operators can see the
   * current quorum state without polling logs.
   */
  pendingOverrideProposals(): Array<OverrideProposal & { quorumRequired: number }> {
    const now = Date.now();
    const result: Array<OverrideProposal & { quorumRequired: number }> = [];
    for (const [id, proposal] of this.pendingOverrides) {
      if (now >= proposal.expiresAt) {
        this.pendingOverrides.delete(id);
        continue;
      }
      result.push({ ...proposal, quorumRequired: this.overrideQuorum });
    }
    return result;
  }

  /**
   * Captures a best-effort blast-radius snapshot for a guardian activation.
   *
   * - For **pause**: records the protocol-wide open-intent count at that instant.
   * - For **blacklist** (solver suspend): records the suspended solver's open
   *   intent ids (capped at {@link SNAPSHOT_MAX_INTENT_IDS}) and their count.
   *
   * The snapshot is fire-and-forget relative to applying guardian state: a slow
   * or failed query here never delays or blocks the pause/suspend taking effect.
   * Duplicate activations for the same action id are skipped via the unique
   * constraint on `action_id` (the upsert silently ignores the conflict).
   */
  private async captureImpactSnapshot(record: GuardianActionRecord): Promise<void> {
    if (!this.intentsRepo) return;

    const allIntents = await this.intentsRepo.findAll();
    const openStates = new Set(["open", "accepted"]);

    let openIntentCount: number;
    let affectedIntentIds: string[];
    let solverAddress: string | undefined;

    if (record.kind === "blacklist") {
      solverAddress = record.target;
      const solverOpen = allIntents.filter(
        (i) => openStates.has(i.state) && i.solver === solverAddress,
      );
      affectedIntentIds = solverOpen
        .slice(0, SNAPSHOT_MAX_INTENT_IDS)
        .map((i) => i.intentId);
      openIntentCount = solverOpen.length;
    } else {
      // pause
      const protocolOpen = allIntents.filter((i) => openStates.has(i.state));
      openIntentCount = protocolOpen.length;
      affectedIntentIds = [];
    }

    const snapshot: GuardianImpactSnapshot = {
      actionId: record.id,
      kind: record.kind as "pause" | "blacklist",
      solverAddress,
      openIntentCount,
      affectedIntentIds,
      capturedAt: new Date().toISOString(),
    };

    await this.persist(() =>
      this.prisma.guardianImpactSnapshot.upsert({
        where: { actionId: record.id },
        create: {
          actionId: snapshot.actionId,
          kind: snapshot.kind,
          solverAddress: snapshot.solverAddress ?? null,
          openIntentCount: snapshot.openIntentCount,
          affectedIntentIds: snapshot.affectedIntentIds,
          capturedAt: new Date(snapshot.capturedAt),
        },
        update: {},
      }),
    );

    this.logger.log(
      `[guardian] impact snapshot: action=${record.id} kind=${record.kind} ` +
        `openIntentCount=${openIntentCount} affectedIds=${affectedIntentIds.length}`,
    );
  }

  /** Cancels the pending override proposal for the given action key, if one exists. */
  private cancelPendingOverrideForKey(key: string, reason: string): void {
    // The key is "kind:target"; we need to find the matching actionId.
    for (const [actionId, proposal] of this.pendingOverrides) {
      const matchingRecord = [...this.active.values()].find((a) => a.id === actionId);
      if (matchingRecord && keyOf(matchingRecord.kind, matchingRecord.target) === key) {
        this.pendingOverrides.delete(actionId);
        this.logger.warn(`[guardian] cancelled pending override proposal for ${actionId}: ${reason}`);
        return;
      }
      // The active record may have already been replaced — also check by scanning all proposals
      // whose action is no longer in `active` with this key (cover the clear path).
    }
    // If no matching active record found, still try to cancel by scanning proposals
    // for actions no longer in active (e.g. on a guardian clear).
    for (const [actionId, _proposal] of this.pendingOverrides) {
      if (!this.active.has(key)) {
        // Check if this proposal targets the same key-mapped action that just cleared.
        // We rely on the caller (apply) already having removed the entry from `active`.
        // So any proposal whose action is gone from active is stale.
        const stillActive = [...this.active.values()].some((a) => a.id === actionId);
        if (!stillActive) {
          this.pendingOverrides.delete(actionId);
          this.logger.warn(`[guardian] cancelled stale pending override proposal for ${actionId}: ${reason}`);
        }
      }
    }
  }

  /**
   * Public status: active guardian actions with tx references, plus any
   * active operator kill switches (#477) so both pause sources are visible.
   */
  status() {
    const operatorSwitches = this.killSwitch?.status().switches.filter((s) => s.active) ?? [];
    const guardianPaused = this.state.pauseRef() !== null;
    return {
      paused: guardianPaused || operatorSwitches.some((s) => s.scope === "global"),
      guardianPaused,
      operatorSwitches,
      guardianActions: [...this.active.values()].sort((a, b) => a.ledger - b.ledger),
      pendingOverrides: this.pendingOverrideProposals(),
      ingestionEnabled: Boolean(this.contractId),
      nextLedger: this.cursor ?? null,
    };
  }

  /** Reloads persisted actions so state survives restarts before the first poll. */
  private async restore(): Promise<void> {
    try {
      const rows = await this.prisma.guardianAction.findMany();
      for (const row of rows) {
        this.seen.add(row.id);
        if (!row.active) continue;
        const record: GuardianActionRecord = {
          id: row.id,
          kind: row.kind as GuardianActionRecord["kind"],
          target: row.target,
          txHash: row.txHash,
          ledger: row.ledger,
          activatedAt: row.activatedAt.toISOString(),
        };
        this.active.set(keyOf(record.kind, record.target), record);
        this.project(record, true, "restored guardian action");
      }
    } catch (err) {
      this.logger.warn(`[guardian] could not restore persisted actions; relying on replay: ${(err as Error).message}`);
    }
  }

  private project(record: GuardianActionRecord, active: boolean, reason: string): void {
    const ref: StateRef = { since: record.activatedAt, reason, actionId: record.id, txHash: record.txHash };
    if (record.kind === "pause") this.state.setPause(active, ref);
    else if (record.kind === "freeze") this.state.setParamFrozen(record.target || ALL_PARAMS, active, ref);
    else this.state.setSolverSuspended(record.target, active, ref);
  }

  /** State is already applied in memory; persistence failures are logged, not fatal. */
  private async persist(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (err) {
      this.logger.error(`[guardian] failed to persist action state: ${(err as Error).message}`);
    }
  }
}
