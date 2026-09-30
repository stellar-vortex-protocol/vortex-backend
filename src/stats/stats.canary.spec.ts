import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { StatsService } from "./stats.service";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "../intents/intents.gateway";
import { Intent } from "../intents/intents.types";

function intent(overrides: Partial<Intent>): Intent {
  return {
    intentId: "id",
    user: "GUSER",
    srcChain: "ethereum",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "filled",
    createdAt: 1_000,
    deadline: 2_000,
    filledAt: 1_010,
    fillAmount: "100",
    feeAmount: "5",
    ...overrides,
  };
}

describe("StatsService canary exclusion (#496)", () => {
  it("excludes canary intents and solvers from public protocol and treasury stats", async () => {
    const intents = [
      intent({ intentId: "real", user: "GREAL", solver: "GREALSOLVER" }),
      intent({ intentId: "canary", user: "GCANARYUSER", solver: "GCANARYSOLVER", fillAmount: "999" }),
    ];
    const solvers = [
      { address: "GREALSOLVER", isActive: true },
      { address: "GCANARYSOLVER", isActive: true },
    ];
    const config = {
      get: () => ["GCANARYUSER", "GCANARYSOLVER"],
    } as unknown as ConfigService<AppConfig, true>;
    const service = new StatsService(
      { getAll: jest.fn().mockResolvedValue(intents) } as unknown as IntentsService,
      { getAll: jest.fn().mockResolvedValue(solvers) } as unknown as SolversService,
      {} as IntentsGateway,
      config,
    );

    const stats = await service.getProtocolStats();
    expect(stats).toMatchObject({ totalIntents: 1, totalVolume: "100", uniqueUsers: 1, activeSolvers: 1 });
    const treasury = await service.getTreasuryStats();
    expect(treasury.allTime).toEqual({ totalFees: "5", filledIntents: 1 });
  });
});
