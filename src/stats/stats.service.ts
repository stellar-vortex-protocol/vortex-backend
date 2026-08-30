import { Injectable } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { SUPPORTED_CHAINS } from "../intents/intents.types";
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

  async getPublicStats() {
    const intents = await this.intentsService.getAll();
    const solvers = await this.solversService.getAll();
    const totalVolume = intents
      .filter((intent) => intent.state === "filled")
      .reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n);

    const perChain = Object.fromEntries(
      SUPPORTED_CHAINS.map((chain) => {
        const chainIntents = intents.filter((intent) => intent.srcChain === chain);
        const filledIntents = chainIntents.filter((intent) => intent.state === "filled");
        const chainVolume = filledIntents.reduce(
          (sum, intent) => sum + BigInt(intent.fillAmount ?? "0"),
          0n,
        );

        return [
          chain,
          {
            intentCount: chainIntents.length,
            filledIntentCount: filledIntents.length,
            totalVolume: chainVolume.toString(),
          },
        ];
      }),
    );

    return {
      contract: "protocol-transparency-v1",
      schemaVersion: "1.0",
      generatedAt: Math.floor(Date.now() / 1000),
      totalIntents: intents.length,
      openIntents: intents.filter((intent) => intent.state === "open").length,
      filledIntents: intents.filter((intent) => intent.state === "filled").length,
      totalVolume: totalVolume.toString(),
      activeSolverCount: solvers.filter((solver) => solver.isActive).length,
      wsSubscriberCount: this.intentsGateway.getSubscriberCount(),
      perChain,
    };
  }

  getWsStats() {
    return {
      subscriberCount: this.intentsGateway.getSubscriberCount(),
    };
  }
}
