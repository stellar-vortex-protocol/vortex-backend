import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { isCanaryIntent } from "../common/canary";
import { IntentsService } from "../intents/intents.service";
import { SUPPORTED_CHAINS } from "../intents/intents.types";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "../intents/intents.gateway";
import { CanaryRegistryService } from "../admin/canary-registry.service";

/** Rolling window definitions (in seconds) exposed by `GET /api/v1/stats/windows`. */
export const STATS_WINDOWS = {
  "1h": 3_600,
  "24h": 86_400,
  "7d": 604_800,
} as const;

export type StatsWindowKey = keyof typeof STATS_WINDOWS;

@Injectable()
export class StatsService {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
    @Optional() private readonly canaryRegistry?: CanaryRegistryService,
    @Optional() config?: ConfigService<AppConfig, true>,
  ) {
    // Seed fallback only: used when no registry is wired (e.g. isolated unit tests).
    this.seedCanary = new Set(config?.get("canaryAddresses", { infer: true }) ?? []);
  }

  /** Bootstrap canary addresses (issue #496) used only when no registry is available. */
  private readonly seedCanary: ReadonlySet<string>;

  /**
   * Canary addresses (issue #496) — their intents and solvers never count toward public stats.
   * Read from the runtime registry on every call so add/remove takes effect without a restart.
   */
  private async canaryAddresses(): Promise<ReadonlySet<string>> {
    if (!this.canaryRegistry) return this.seedCanary;
    return new Set(await this.canaryRegistry.getAddresses());
  }

  private async publicIntents(canary?: ReadonlySet<string>) {
    const canarySet = canary ?? (await this.canaryAddresses());
    return (await this.intentsService.getAll()).filter((i) => !isCanaryIntent(i, canarySet));
  }

  /**
   * Compute the protocol stats shape for a single window.
   * `sinceEpochSeconds` is inclusive; `null` means all-time.
   */
  private computeStatsForWindow(
    intents: ReadonlyArray<{ state: string; fillAmount?: string | null; filledAt?: number | null; createdAt: number; user: string }>,
    activeSolvers: number,
    sinceEpochSeconds: number | null,
  ) {
    const windowed =
      sinceEpochSeconds == null ? intents : intents.filter((i) => i.createdAt >= sinceEpochSeconds);

    const open = windowed.filter((i) => i.state === "open").length;
    const filled = windowed.filter((i) => i.state === "filled");
    const totalVolume = filled.reduce((sum, i) => sum + BigInt(i.fillAmount ?? "0"), 0n);

    const fillTimes = filled
      .filter((i) => i.filledAt != null)
      .map((i) => i.filledAt! - i.createdAt);
    const avgFillTime = fillTimes.length
      ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
      : 0;

    return {
      totalIntents: windowed.length,
      openIntents: open,
      totalVolume: totalVolume.toString(),
      uniqueUsers: new Set(windowed.map((i) => i.user)).size,
      activeSolvers,
      avgFillTime: Math.round(avgFillTime),
      fillRate: windowed.length ? filled.length / windowed.length : 0,
    };
  }

  async getProtocolStats() {
    const canary = await this.canaryAddresses();
    const intents = await this.publicIntents(canary);
    const solvers = (await this.solversService.getAll()).filter((s) => !canary.has(s.address));
    const activeSolvers = solvers.filter((s) => s.isActive).length;

    return this.computeStatsForWindow(intents, activeSolvers, null);
  }

  /**
   * Rolling window breakdown: `1h`, `24h`, `7d` and `allTime`, computed in a single pass
   * over the public (canary-excluded) intent set.
   */
  async getWindowedStats() {
    const canary = await this.canaryAddresses();
    const intents = await this.publicIntents(canary);
    const solvers = (await this.solversService.getAll()).filter((s) => !canary.has(s.address));
    const activeSolvers = solvers.filter((s) => s.isActive).length;

    const now = Math.floor(Date.now() / 1000);
    const result = {} as Record<StatsWindowKey | "allTime", ReturnType<StatsService["computeStatsForWindow"]>>;

    for (const [key, seconds] of Object.entries(STATS_WINDOWS) as [StatsWindowKey, number][]) {
      result[key] = this.computeStatsForWindow(intents, activeSolvers, now - seconds);
    }
    result.allTime = this.computeStatsForWindow(intents, activeSolvers, null);

    return result;
  }

  async getTreasuryStats() {
    const intents = await this.publicIntents();
    const now = Math.floor(Date.now() / 1000);
    const last24hCutoff = now - 86_400;

    const allTime = intents
      .filter((intent) => typeof intent.feeAmount === "string" && intent.feeAmount.length > 0)
      .reduce((sum, intent) => sum + BigInt(intent.feeAmount ?? "0"), 0n);

    const last24h = intents
      .filter(
        (intent) =>
          typeof intent.feeAmount === "string" &&
          intent.feeAmount.length > 0 &&
          typeof intent.filledAt === "number" &&
          intent.filledAt >= last24hCutoff,
      )
      .reduce((sum, intent) => sum + BigInt(intent.feeAmount ?? "0"), 0n);

    const byChain = new Map<string, { totalFees: bigint; last24hFees: bigint; filledCount: number }>();

    for (const intent of intents) {
      if (typeof intent.feeAmount !== "string" || intent.feeAmount.length === 0) continue;
      const fee = BigInt(intent.feeAmount ?? "0");
      const entry = byChain.get(intent.srcChain) ?? {
        totalFees: 0n,
        last24hFees: 0n,
        filledCount: 0,
      };

      entry.totalFees += fee;
      entry.filledCount += 1;
      if (typeof intent.filledAt === "number" && intent.filledAt >= last24hCutoff) {
        entry.last24hFees += fee;
      }
      byChain.set(intent.srcChain, entry);
    }

    return {
      allTime: {
        totalFees: allTime.toString(),
        filledIntents: intents.filter((intent) => typeof intent.feeAmount === "string" && intent.feeAmount.length > 0).length,
      },
      last24h: {
        totalFees: last24h.toString(),
        filledIntents: intents.filter(
          (intent) =>
            typeof intent.feeAmount === "string" &&
            intent.feeAmount.length > 0 &&
            typeof intent.filledAt === "number" &&
            intent.filledAt >= last24hCutoff,
        ).length,
      },
      byChain: Array.from(byChain.entries()).map(([srcChain, stats]) => ({
        srcChain,
        totalFees: stats.totalFees.toString(),
        last24hFees: stats.last24hFees.toString(),
        filledIntents: stats.filledCount,
      })),
    };
  }

  getWsStats() {
    return {
      subscriberCount: this.intentsGateway.getSubscriberCount(),
    };
  }
}
