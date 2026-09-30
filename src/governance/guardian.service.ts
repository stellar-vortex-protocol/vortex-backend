import {
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

/** Guardian actions are applied within one poll of this interval. */
export const GUARDIAN_POLL_INTERVAL_MS = 10_000;
/** On start, replay this many ledgers (~24 h at 5 s) to catch actions missed while down. */
export const GUARDIAN_LOOKBACK_LEDGERS = 17_280;

/** An active guardian action, as shown on the public status endpoint. */
export interface GuardianActionRecord {
  id: string;
  kind: GuardianEvent["kind"];
  target: string;
  txHash: string;
  ledger: number;
  activatedAt: string;
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
  private readonly active = new Map<string, GuardianActionRecord>();
  private readonly seen = new Set<string>();
  private cursor?: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly soroban: SorobanService,
    private readonly state: GuardianStateService,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly killSwitch?: KillSwitchService,
  ) {
    this.contractId = config.get("guardianContractId", { infer: true });
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
      this.project(record, true, "guardian action");
      await this.persist(() =>
        this.prisma.guardianAction.upsert({
          where: { id: record.id },
          create: { ...record, active: true, activatedAt: new Date(record.activatedAt) },
          update: {},
        }),
      );
      return;
    }

    // A clear only affects an action activated before it (replay-safe).
    if (!current || !isAfter(event, current)) return;
    this.active.delete(key);
    this.project(current, false, `guardian cleared (tx ${event.txHash})`);
    await this.persist(() =>
      this.prisma.guardianAction.update({
        where: { id: current.id },
        data: { active: false, clearedAt: new Date(event.ledgerClosedAt), clearedTxHash: event.txHash },
      }),
    );
  }

  /**
   * Superadmin break-glass: lifts an active guardian action (e.g. a false
   * positive) until the guardian emits a new one. Refused unless the audit
   * record is written.
   */
  async override(actionId: string, admin: AdminPrincipal, reason: string): Promise<GuardianActionRecord> {
    const record = [...this.active.values()].find((a) => a.id === actionId);
    if (!record) throw new NotFoundException("No active guardian action with that id");
    await this.audit.record({
      actor: admin.id,
      action: "guardian.override",
      target: `guardian:${record.id}`,
      before: record,
      reason,
    });
    this.active.delete(keyOf(record.kind, record.target));
    this.project(record, false, `superadmin override by ${admin.id}: ${reason}`);
    await this.persist(() =>
      this.prisma.guardianAction.update({
        where: { id: record.id },
        data: { active: false, clearedAt: new Date(), overriddenBy: admin.id },
      }),
    );
    return record;
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
