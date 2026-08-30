import { Injectable } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "../intents/intents.gateway";

@Injectable()
export class StatsService {
  private cachedProtocolStats:
    | { expiresAt: number; value: ReturnType<StatsService["buildProtocolStats"]> }
    | null = null;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  async getProtocolStats() {
    const intents = await this.intentsService.getAll();
    const solvers = await this.solversService.getAll();

    const open = intents.filter((i) => i.state === "open").length;
    const filled = intents.filter((i) => i.state === "filled");
    const totalVolume = filled.reduce((sum, i) => sum + BigInt(i.fillAmount ?? "0"), 0n);

    const fillTimes = filled
      .filter((i) => i.filledAt != null)
      .map((i) => i.filledAt! - i.createdAt);
    const avgFillTime = fillTimes.length
      ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
      : 0;

    return {
      totalIntents: intents.length,
      openIntents: open,
      totalVolume: totalVolume.toString(),
      uniqueUsers: new Set(intents.map((i) => i.user)).size,
      activeSolvers: solvers.filter((s) => s.isActive).length,
      avgFillTime: Math.round(avgFillTime),
      fillRate: intents.length ? filled.length / intents.length : 0,
    };
  }

  async getTreasuryStats() {
    const intents = await this.intentsService.getAll();
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
