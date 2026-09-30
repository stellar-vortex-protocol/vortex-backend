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
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  Client,
  EvaluationContext,
  OpenFeature,
  Provider,
  ResolutionDetails,
  StandardResolutionReasons,
  ErrorCode,
} from "@openfeature/server-sdk";
import { Prisma } from "@prisma/client";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { AdminAuditService } from "../admin/admin-audit.service";
import { AdminPrincipal } from "../admin/admin-auth";
import { MetricsService } from "../metrics/metrics.service";
import { GuardianStateService } from "../governance/guardian-state.service";
import { evaluateFlag } from "./flag-evaluator";
import { FLAG_REGISTRY, FlagKey, isFlagKey, parseFlagOverrides } from "./flag-registry";
import { FlagBus, InMemoryFlagBus, RedisFlagBus } from "./flag-bus";
import { FlagContext, FlagState, StoredFlag } from "./flag.types";

/** Optional injection token to supply a custom {@link FlagBus} (tests). */
export const FLAG_BUS = Symbol("FLAG_BUS");

type FlagMap = ReadonlyMap<string, StoredFlag>;

export type FlagUpdateResult =
  | { status: "applied"; flag: StoredFlag }
  | { status: "pending"; requestId: string; approvals: string[] };

/**
 * Runtime feature flags (issue #495), exposed through an OpenFeature provider.
 *
 * Resolution order: FLAG_OVERRIDES pin → DB rules/default → env default.
 * Evaluation reads a local in-memory copy (no I/O); the copy is replaced on
 * pub/sub change notifications and on a FLAGS_REFRESH_MS safety-net reload,
 * and kept as last-known state when the DB is unreachable. Within an HTTP
 * request every evaluation reads the snapshot taken when the request began
 * (see {@link runWithSnapshot}), so a mid-request flip cannot split behaviour.
 */
@Injectable()
export class FeatureFlagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly instanceId = randomUUID();
  private readonly snapshots = new AsyncLocalStorage<FlagMap>();
  private readonly overrides: Map<FlagKey, boolean>;
  private readonly bus: FlagBus;
  private flags: FlagMap = new Map();
  private refreshTimer?: NodeJS.Timeout;
  private client!: Client;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly guardian?: GuardianStateService,
    @Optional() @Inject(FLAG_BUS) bus?: FlagBus,
  ) {
    const flags = config.get("flags", { infer: true });
    this.overrides = parseFlagOverrides(flags.overrides ?? "");
    this.bus =
      bus ??
      (flags.pubsub === "redis"
        ? new RedisFlagBus(config.get("redisUrl", { infer: true }))
        : new InMemoryFlagBus());
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
    await this.bus.subscribe((msg) => {
      if (msg.origin !== this.instanceId) void this.reload();
    });
    this.refreshTimer = setInterval(() => void this.reload(), this.config.get("flags", { infer: true }).refreshMs);
    this.refreshTimer.unref?.();

    const domain = `vortex-flags:${this.instanceId}`;
    await OpenFeature.setProviderAndWait(domain, this.provider);
    this.client = OpenFeature.getClient(domain);
    this.client.addHooks({
      after: (hookCtx, details) => {
        this.metrics?.flagEvaluations.inc({
          flag: hookCtx.flagKey,
          value: String(details.value),
          reason: details.reason ?? "UNKNOWN",
        });
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.bus.close();
  }

  /**
   * Evaluates a boolean flag through the OpenFeature client. Never throws:
   * on any error OpenFeature returns the env default.
   */
  async getBooleanValue(key: FlagKey, ctx: FlagContext = {}): Promise<boolean> {
    return this.client.getBooleanValue(key, this.envDefault(key), { ...ctx });
  }

  /** Runs `fn` with every evaluation pinned to the current flag state. */
  runWithSnapshot<T>(fn: () => T): T {
    return this.snapshots.run(this.flags, fn);
  }

  /** Re-reads all flags; on failure keeps the last-known state. */
  async reload(): Promise<void> {
    try {
      const rows = await this.prisma.featureFlag.findMany();
      this.flags = new Map(
        rows.map((row) => [
          row.key,
          {
            key: row.key,
            defaultValue: row.defaultValue,
            rules: row.rules as unknown as StoredFlag["rules"],
            version: row.version,
            updatedBy: row.updatedBy,
            updatedAt: row.updatedAt.toISOString(),
          },
        ]),
      );
    } catch (err) {
      this.logger.warn(`[flags] reload failed, serving last-known state: ${(err as Error).message}`);
    }
  }

  /** Every managed flag with its env default, override pin and stored state. */
  list() {
    return (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => ({
      key,
      description: FLAG_REGISTRY[key].description,
      envDefault: this.envDefault(key),
      override: this.overrides.get(key),
      stored: this.flags.get(key) ?? null,
    }));
  }

  /**
   * Applies a new state, or opens a change request when the flag's safety
   * policy needs a second approver (dry-run off in production).
   */
  async update(key: string, state: FlagState, admin: AdminPrincipal, reason: string): Promise<FlagUpdateResult> {
    const flagKey = this.assertMutable(key);
    const spec = FLAG_REGISTRY[flagKey] as { requiresTwoApprovals?: (s: FlagState, env: string) => boolean };
    if (spec.requiresTwoApprovals?.(state, this.config.get("nodeEnv", { infer: true }))) {
      const request = await this.prisma.$transaction(async (tx) => {
        const created = await tx.flagChangeRequest.create({
          data: { flagKey, proposed: state as object, proposedBy: admin.id, approvals: [admin.id], reason },
        });
        await this.audit.record(
          { actor: admin.id, action: "flag.change-requested", target: `flag:${flagKey}`, after: state, reason },
          tx,
        );
        return created;
      });
      return { status: "pending", requestId: request.id, approvals: request.approvals };
    }
    return { status: "applied", flag: await this.apply(flagKey, state, admin.id, reason) };
  }

  /** Second approval for a pending change; a distinct admin applies it. */
  async approve(requestId: string, admin: AdminPrincipal): Promise<FlagUpdateResult> {
    const request = await this.prisma.flagChangeRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "pending") throw new NotFoundException("No pending change request");
    if (request.approvals.includes(admin.id)) {
      throw new ConflictException("Approval must come from a different admin");
    }
    const flagKey = this.assertMutable(request.flagKey);
    const approvals = [...request.approvals, admin.id];
    const flag = await this.apply(
      flagKey,
      request.proposed as unknown as FlagState,
      admin.id,
      `approved change request ${requestId} (approvals: ${approvals.join(", ")})${request.reason ? `: ${request.reason}` : ""}`,
      async (tx) => {
        // Claim the request in the same transaction so concurrent approvals apply it once.
        const claimed = await tx.flagChangeRequest.updateMany({
          where: { id: requestId, status: "pending" },
          data: { status: "applied", approvals, appliedAt: new Date() },
        });
        if (claimed.count === 0) throw new ConflictException("Change request was already applied");
      },
    );
    return { status: "applied", flag };
  }

  private async apply(
    key: FlagKey,
    state: FlagState,
    actor: string,
    reason: string,
    precondition?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<StoredFlag> {
    const before = this.flags.get(key) ?? null;
    const row = await this.prisma.$transaction(async (tx) => {
      await precondition?.(tx);
      const saved = await tx.featureFlag.upsert({
        where: { key },
        create: { key, defaultValue: state.defaultValue, rules: state.rules as object[], updatedBy: actor },
        update: {
          defaultValue: state.defaultValue,
          rules: state.rules as object[],
          updatedBy: actor,
          version: { increment: 1 },
        },
      });
      await this.audit.record({ actor, action: "flag.update", target: `flag:${key}`, before, after: state, reason }, tx);
      return saved;
    });
    const stored: StoredFlag = {
      key,
      defaultValue: row.defaultValue,
      rules: state.rules,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
    this.flags = new Map(this.flags).set(key, stored);
    await this.bus
      .publish({ key, version: stored.version, origin: this.instanceId })
      .catch((err) => this.logger.error(`[flags] change publish failed; peers catch up on refresh: ${err.message}`));
    return stored;
  }

  private assertMutable(key: string): FlagKey {
    if (!isFlagKey(key)) throw new BadRequestException(`Unknown flag "${key}"`);
    if (this.guardian?.isParamFrozen(key)) {
      throw new ConflictException(`Flag "${key}" is frozen by a guardian action`);
    }
    return key;
  }

  private envDefault(key: FlagKey): boolean {
    return FLAG_REGISTRY[key].envDefault({
      onchainIntentsEnabled: this.config.get("onchainIntentsEnabled", { infer: true }),
      onchainDryRun: this.config.get("onchainDryRun", { infer: true }),
    });
  }

  private readonly provider: Provider = {
    metadata: { name: "vortex-db" },
    runsOn: "server",
    resolveBooleanEvaluation: async (
      flagKey: string,
      defaultValue: boolean,
      context: EvaluationContext,
    ): Promise<ResolutionDetails<boolean>> => {
      const pinned = isFlagKey(flagKey) ? this.overrides.get(flagKey) : undefined;
      if (pinned !== undefined) return { value: pinned, reason: StandardResolutionReasons.STATIC };
      const stored = (this.snapshots.getStore() ?? this.flags).get(flagKey);
      if (!stored) return { value: defaultValue, reason: StandardResolutionReasons.DEFAULT };
      const { value, reason, ruleIndex } = evaluateFlag(flagKey, stored, context as FlagContext);
      return { value, reason, variant: ruleIndex === undefined ? "default" : `rule-${ruleIndex}` };
    },
    resolveStringEvaluation: async (_k, defaultValue) => typeMismatch(defaultValue),
    resolveNumberEvaluation: async (_k, defaultValue) => typeMismatch(defaultValue),
    resolveObjectEvaluation: async (_k, defaultValue) => typeMismatch(defaultValue),
  };
}

function typeMismatch<T>(value: T): ResolutionDetails<T> {
  return {
    value,
    reason: StandardResolutionReasons.ERROR,
    errorCode: ErrorCode.TYPE_MISMATCH,
    errorMessage: "Only boolean flags are supported",
  };
}
