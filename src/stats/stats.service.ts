import { Injectable } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";

@Injectable()
export class StatsService {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
  ) {}

  getProtocolStats() {
    const intents = this.intentsService.getAll();
    const solvers = this.solversService.getAll();

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
}
