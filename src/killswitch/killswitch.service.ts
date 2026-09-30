import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { KILL_SWITCH_REPOSITORY, KillSwitchRecord, KillSwitchRepository } from "./killswitch.repository";
import {
  KillSwitchOperation,
  KillSwitchScope,
  SwitchDecision,
  SwitchSnapshotEntry,
  SwitchTarget,
  isKillSwitchOperation,
} from "./killswitch.types";
import { evaluate } from "./killswitch.evaluate";
import { GuardianStateService } from "../governance/guardian-state.service";

/** Redis channel every replica subscribes to for invalidation notices. */
export const KILL_SWITCH_CHANNEL = "vortex:killswitch:invalidate";

/**
 * Minimal structural type for the Redis client, declared locally so the
 * optional `redis` dependency stays optional — same lazy-require approach as
 * the WS backplane (src/intents/intents.gateway.ts).
 */
type RedisLike = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  publish: (channel: string, message: string) => Promise<unknown>;
  subscribe: (channel: string, listener: () => void) => Promise<unknown>;
  on: (event: string, listener: (err: Error) => void) => unknown;
};

function tryRequireRedis(): { createClient: (opts: { url: string }) => RedisLike } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const redis = require("redis") as { createClient: (opts: { url: string }) => RedisLike } | undefined;
    return typeof redis?.createClient === "function" ? redis : null;
  } catch {
    return null;
  }
}

/**
 * Emergency pause service (issue #477).
 *
 * Design
 * ──────
 * Every replica keeps a local snapshot of all switches in memory and evaluates
 * against it synchronously, so a write is never delayed by a network round trip
 * and a Redis outage cannot stall the hot path.
 *
 * Propagation has two independent mechanisms so a pause always lands:
 *   1. Redis pub/sub — push, usually sub-second.
 *   2. Database polling — `maxUpdatedAt` probe every `KILLSWITCH_POLL_MS`,
 *      which is the durable backstop when Redis is absent or the pub/sub
 *      connection drops. Defaults keep the worst case under the 5 s budget.
 *
 * The snapshot is refreshed once at startup and on every invalidation, so a
 * replica never serves a write from an empty cache; a failed initial load makes
 * `isReady` false and the guard fails closed.
 */
@Injectable()
export class KillSwitchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(KillSwitchService.name);

  private snapshot: SwitchSnapshotEntry[] = [];
  private lastUpdatedAt = 0;
  private ready = false;

  private redis: RedisLike | null = null;
  private subscriber: RedisLike | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** Serialises refreshes so a burst of invalidations cannot pile up queries. */
  private refreshInFlight: Promise<void> | null = null;

  /**
   * WS notifier for `protocol_status` events. Set by KillSwitchModule to the
   * gateway's broadcast; kept as a field to break the module cycle.
   */
  broadcastStatus:
    | ((event: { type: string; [key: string]: unknown }) => Promise<void>)
    | null = null;

  constructor(
    @Inject(KILL_SWITCH_REPOSITORY) private readonly repo: KillSwitchRepository,
    private readonly config: ConfigService,
    @Optional() private readonly guardian?: GuardianStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refresh();
      this.ready = true;
    } catch (err) {
      // Fail closed: without a snapshot we cannot prove a write is safe.
      this.log.error(
        `Kill-switch snapshot failed to load; writes will fail closed until it succeeds: ${(err as Error).message}`,
      );
    }

    await this.startPropagation();
    this.startPolling();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.disconnectRedis();
  }

  /** True once the local snapshot has been loaded at least once. */
  isReady(): boolean {
    return this.ready;
  }

  // ── evaluation ──────────────────────────────────────────────────────────

  /**
   * Synchronous, allocation-light check used on the hot path of every write.
   * Never throws: any unexpected state resolves to "paused" (fail closed).
   */
  isBlocked(target: SwitchTarget & { operation: KillSwitchOperation }): boolean {
    try {
      if (!this.ready) return true;
      return this.evaluateTarget(target).paused;
    } catch (err) {
      this.log.error(`Kill-switch evaluation failed; failing closed: ${(err as Error).message}`);
      return true;
    }
  }

  /** Same evaluation as {@link isBlocked}, but returns the full decision. */
  evaluateTarget(target: SwitchTarget & { operation: KillSwitchOperation }): SwitchDecision {
    if (!this.ready) {
      return {
        paused: true,
        matched: null,
        matchedChain: [],
      };
    }
    // An active on-chain guardian pause (#507) acts as a global switch that
    // operators cannot resume; operator switches are evaluated independently,
    // so the protocol stays paused until both sources clear.
    const guardianPause = this.guardian?.pauseRef();
    if (guardianPause) {
      const entry: SwitchSnapshotEntry = {
        scope: "global",
        chain: null,
        token: null,
        operation: null,
        active: true,
        reasonCode: "GUARDIAN_PAUSE",
        reason: `On-chain guardian pause (tx ${guardianPause.txHash ?? "unknown"})`,
        activatedBy: "guardian",
        updatedAt: Date.parse(guardianPause.since) || Date.now(),
      };
      return { paused: true, matched: entry, matchedChain: [entry] };
    }
    try {
      return evaluate(this.snapshot, target);
    } catch (err) {
      this.log.error(`Kill-switch evaluation failed; failing closed: ${(err as Error).message}`);
      return { paused: true, matched: null, matchedChain: [] };
    }
  }

  /** Current snapshot, for /health and the operator status endpoint. */
  status(): {
    ready: boolean;
    lastUpdatedAt: number;
    propagation: "redis" | "db-poll";
    switches: SwitchSnapshotEntry[];
  } {
    return {
      ready: this.ready,
      lastUpdatedAt: this.lastUpdatedAt,
      propagation: this.redis ? "redis" : "db-poll",
      switches: this.snapshot,
    };
  }

  // ── mutations ───────────────────────────────────────────────────────────

  /** Pause a scope. Idempotent; re-pausing refreshes the reason and clears approvals. */
  async pause(input: {
    scope: KillSwitchScope;
    chain?: string | null;
    token?: string | null;
    operation?: KillSwitchOperation | null;
    reasonCode: string;
    reason: string;
    activatedBy: string;
  }): Promise<KillSwitchRecord> {
    const normalised = KillSwitchService.normaliseScope(input);
    const record = await this.repo.activate({
      ...input,
      ...normalised,
      now: Date.now(),
    });

    // Local first: the calling replica must be closed before it acknowledges.
    await this.refresh();
    await this.broadcast();

    this.log.warn(
      `Kill-switch PAUSED scope=${record.scope} chain=${record.chain ?? "*"} token=${record.token ?? "*"} ` +
        `operation=${record.operation ?? "*"} reason=${record.reasonCode} by=${record.activatedBy}`,
    );
    await this.announce("paused", record);
    return record;
  }

  /**
   * Approve a resume. The switch only actually resumes once
   * `approvalsRequired` distinct operators have approved; until then the caller
   * gets the still-active record back.
   */
  async approveResume(input: {
    id: string;
    approver: string;
    approvalsRequired: number;
    note?: string;
  }): Promise<{ record: KillSwitchRecord; resumed: boolean; approvals: number; required: number }> {
    const record = await this.repo.resumeIfApproved(
      input.id,
      input.approver,
      input.approvalsRequired,
      input.note,
      Date.now(),
    );

    const approvals = await this.repo.listApprovals(input.id);
    const resumed = !record.active;

    await this.refresh();
    if (resumed) await this.broadcast();

    const verb = resumed ? "RESUMED" : "approval recorded";
    this.log.warn(
      `Kill-switch ${verb} id=${input.id} scope=${record.scope} by=${input.approver} ` +
        `approvals=${approvals.length}/${input.approvalsRequired}`,
    );
    if (resumed) await this.announce("resumed", record);

    return { record, resumed, approvals: approvals.length, required: input.approvalsRequired };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Enforce the schema invariant that scope determines which columns may be
   * set. Doing this here means the evaluation logic never has to defend against
   * a malformed row, and operators cannot accidentally create an unreachable
   * switch (e.g. `operation` scope with no operation).
   */
  static normaliseScope(input: {
    scope: KillSwitchScope;
    chain?: string | null;
    token?: string | null;
    operation?: KillSwitchOperation | null;
  }): { scope: KillSwitchScope; chain: string | null; token: string | null; operation: KillSwitchOperation | null } {
    const { scope } = input;
    const chain = input.chain ?? null;
    const token = input.token ?? null;
    const operation = input.operation ?? null;

    if (scope === "global" && (chain || token || operation)) {
      throw new Error("A global kill-switch cannot specify chain, token, or operation");
    }
    if (scope === "chain" && (!chain || token || operation)) {
      throw new Error("A chain kill-switch requires chain and cannot specify token or operation");
    }
    if (scope === "token" && (!chain || !token || operation)) {
      throw new Error("A token kill-switch requires chain and token, and cannot specify operation");
    }
    if (scope === "operation" && (!chain || !operation)) {
      throw new Error("An operation kill-switch requires chain and operation");
    }
    if (operation && !isKillSwitchOperation(operation)) {
      throw new Error(`Unknown kill-switch operation: ${operation}`);
    }

    return { scope, chain, token, operation };
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const records = await this.repo.listAll();
        this.snapshot = records.map((record) => ({
          scope: record.scope,
          chain: record.chain,
          token: record.token,
          operation: record.operation,
          active: record.active,
          reasonCode: record.reasonCode,
          reason: record.reason,
          activatedBy: record.activatedBy,
          updatedAt: record.updatedAt,
        }));
        this.lastUpdatedAt = await this.repo.maxUpdatedAt();
        this.ready = true;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  /**
   * Poll `maxUpdatedAt` and only reload when it moves. Cheap enough to run on
   * every replica: one indexed aggregate, no rows transferred.
   */
  private startPolling(): void {
    const interval = this.config.get<number>("killswitch.pollMs") ?? 2000;
    this.pollTimer = setInterval(() => {
      void (async () => {
        try {
          const latest = await this.repo.maxUpdatedAt();
          if (latest !== this.lastUpdatedAt) await this.refresh();
        } catch (err) {
          // Keep serving the last known snapshot: a stale-but-known state is
          // safer than dropping to fail-closed on a transient DB blip, and any
          // active pause is already cached.
          this.log.warn(`Kill-switch poll failed: ${(err as Error).message}`);
        }
      })();
    }, interval);
    // Never hold the event loop open for a background poll.
    this.pollTimer.unref?.();
  }

  private async startPropagation(): Promise<void> {
    const url = this.config.get<string>("killswitch.redisUrl") ?? "";
    if (url === "") return;

    const redis = tryRequireRedis();
    if (!redis) {
      this.log.warn(
        "Kill-switch redis package unavailable, falling back to db polling",
      );
      return;
    }

    try {
      this.subscriber = redis.createClient({ url });
      this.subscriber.on("error", (err: Error) => {
        this.log.warn(`Kill-switch redis subscriber error: ${err.message}`);
      });
      await this.subscriber.connect();
      await this.subscriber.subscribe(KILL_SWITCH_CHANNEL, () => {
        void this.refresh().catch((err: Error) =>
          this.log.warn(`Kill-switch refresh after notification failed: ${err.message}`),
        );
      });

      this.redis = redis.createClient({ url });
      this.redis.on("error", (err: Error) => {
        this.log.warn(`Kill-switch redis publisher error: ${err.message}`);
      });
      await this.redis.connect();

      this.log.log("Kill-switch propagation: redis pub/sub + db polling");
    } catch (err) {
      // Not fatal: the polling backstop still meets the propagation budget.
      this.log.warn(
        `Kill-switch redis unavailable, falling back to db polling: ${(err as Error).message}`,
      );
      await this.disconnectRedis();
    }
  }

  private async disconnectRedis(): Promise<void> {
    await Promise.allSettled([
      this.subscriber?.quit() ?? Promise.resolve(),
      this.redis?.quit() ?? Promise.resolve(),
    ]);
    this.subscriber = null;
    this.redis = null;
  }

  /**
   * Notifies connected WS clients that the protocol's write availability
   * changed, so front-ends can stop retrying and surface the reason.
   *
   * Injected as an optional callback to avoid a module cycle: the gateway
   * already depends on this service's module tree, not the other way round.
   * Failures are swallowed — a pause must succeed even if no client is
   * listening or the broadcast throws.
   */
  private async announce(
    action: "paused" | "resumed",
    entry: { scope: string; chain: string | null; token: string | null; operation: string | null; reasonCode: string; reason: string },
  ): Promise<void> {
    if (!this.broadcastStatus) return;
    try {
      await this.broadcastStatus({
        type: "protocol_status",
        action,
        scope: entry.scope,
        chain: entry.chain,
        token: entry.token,
        operation: entry.operation,
        reasonCode: entry.reasonCode,
        reason: entry.reason,
        paused: action === "paused",
      });
    } catch (err) {
      this.log.warn(`protocol_status broadcast failed: ${(err as Error).message}`);
    }
  }

  /** Best-effort notify other replicas. A failure here is not an error. */
  private async broadcast(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.publish(KILL_SWITCH_CHANNEL, "1");
    } catch (err) {
      this.log.warn(`Kill-switch broadcast failed: ${(err as Error).message}`);
    }
  }
}
