import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IntentsService } from "../intents/intents.service";
import { buildDisputeMessage, verifyStellarSignature, buildSolverStatusMessage } from "../common/stellar-signature";
import { SolversService, LeaderboardWindow } from "./solvers.service";
import { RegisterSolverDto } from "./dto/register-solver.dto";
import { UpdateSolverStatusDto } from "./dto/update-solver-status.dto";

const WINDOW_SECONDS: Record<Exclude<LeaderboardWindow, "all">, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

@ApiTags("solvers")
@Controller("api/v1/solvers")
export class SolversController {
  constructor(
    private readonly solversService: SolversService,
    private readonly intentsService: IntentsService,
  ) {}

  @Post()
  async register(@Body() dto: RegisterSolverDto) {
    return this.solversService.register({
      address: dto.address,
      name: dto.name,
      bondAmount: dto.bondAmount,
      avgFillTime: dto.avgFillTime,
      isActive: true,
      supportedChains: dto.supportedChains,
      supportedTokens: dto.supportedTokens,
    });
  }

  @Get("leaderboard")
  @ApiOperation({
    summary: "Windowed solver leaderboard",
    description:
      "Returns the ranked solver list for a specific window. This endpoint is intended for recent-performance visibility and does not alter the legacy all-time leaderboard.",
  })
  @ApiQuery({ name: "window", required: false, enum: ["24h", "7d", "30d", "all"], description: "Time window over which to compute rankings." })
  async getLeaderboard(@Query("window") window: string = "all") {
    const resolvedWindow = this.normalizeWindow(window);
    const solvers = await this.solversService.getAll();
    const intents = await this.intentsService.getAll();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = resolvedWindow === "all" ? 0 : now - WINDOW_SECONDS[resolvedWindow];

    const ranked = solvers
      .map((solver) => {
        const recentIntents = intents.filter((intent) => {
          if (intent.solver !== solver.address || intent.state !== "filled") return false;
          const timestamp = intent.filledAt ?? intent.createdAt;
          return resolvedWindow === "all" || timestamp >= cutoff;
        });

        const slashedRecent = intents.filter((intent) => {
          if (intent.solver !== solver.address || intent.state !== "slashed") return false;
          const timestamp = intent.slashedAt ?? intent.createdAt;
          return resolvedWindow === "all" || timestamp >= cutoff;
        });

        const fillsCompleted = recentIntents.length;
        const fillsFailed = slashedRecent.length;
        const total = fillsCompleted + fillsFailed;
        const successRate = total > 0 ? fillsCompleted / total : 0;
        const ageDays = Math.max(0, (now - solver.registeredAt) / 86400);
        const reputationScore = Number(
          (successRate * Math.exp(-ageDays / 180)).toFixed(4),
        );

        return {
          address: solver.address,
          name: solver.name,
          fillsCompleted,
          fillsFailed,
          successRate: Number(successRate.toFixed(4)),
          reputationScore,
          totalVolume: recentIntents
            .reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n)
            .toString(),
          avgFillTime: recentIntents.length
            ? Math.round(
                recentIntents.reduce((sum, intent) => {
                  if (!intent.filledAt) return sum;
                  return sum + (intent.filledAt - intent.createdAt);
                }, 0) / recentIntents.length,
              )
            : 0,
          bondAmount: solver.bondAmount,
          isActive: solver.isActive,
          window: resolvedWindow,
        };
      })
      .filter((entry) => entry.fillsCompleted > 0 || entry.fillsFailed > 0 || resolvedWindow === "all")
      .sort((a, b) => b.reputationScore - a.reputationScore || b.fillsCompleted - a.fillsCompleted);

    return { solvers: ranked, count: ranked.length, window: resolvedWindow };
  }

  @Get()
  async getLegacyLeaderboard() {
    const solvers = (await this.solversService.getAll()).sort(
      (a, b) => b.fillsCompleted - a.fillsCompleted,
    );
    return { solvers, count: solvers.length };
  }

  @Get(":address")
  async getSolver(@Param("address") address: string) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return solver;
  }

  @Get(":address/stats")
  async getSolverStats(@Param("address") address: string, @Query("window") window?: string) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");

    const resolvedWindow = this.normalizeWindow(window ?? "all");
    const intents = await this.intentsService.getAll();
    const now = Math.floor(Date.now() / 1000);
    const cutoff = resolvedWindow === "all" ? 0 : now - WINDOW_SECONDS[resolvedWindow];

    const recentIntents = intents.filter((intent) => {
      if (intent.solver !== address) return false;
      const timestamp = intent.state === "filled" ? intent.filledAt ?? intent.createdAt : intent.slashedAt ?? intent.createdAt;
      return resolvedWindow === "all" || timestamp >= cutoff;
    });

    const fillsCompleted = recentIntents.filter((intent) => intent.state === "filled").length;
    const fillsFailed = recentIntents.filter((intent) => intent.state === "slashed").length;
    const total = fillsCompleted + fillsFailed;
    const successRate = total > 0 ? fillsCompleted / total : 0;
    const ageDays = Math.max(0, (now - solver.registeredAt) / 86400);
    const reputationScore = Number((successRate * Math.exp(-ageDays / 180)).toFixed(4));

    return {
      address: solver.address,
      name: solver.name,
      fillsCompleted,
      fillsFailed,
      successRate: Number(successRate.toFixed(4)),
      reputationScore,
      totalVolume: recentIntents
        .filter((intent) => intent.state === "filled")
        .reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n)
        .toString(),
      avgFillTime: recentIntents.filter((intent) => intent.state === "filled" && intent.filledAt != null).length
        ? Math.round(
            recentIntents
              .filter((intent) => intent.state === "filled" && intent.filledAt != null)
              .reduce((sum, intent) => sum + (intent.filledAt! - intent.createdAt), 0) /
              recentIntents.filter((intent) => intent.state === "filled" && intent.filledAt != null).length,
          )
        : 0,
      bondAmount: solver.bondAmount,
      window: resolvedWindow,
    };
  }

  @Get(":address/slashes")
  async getSlashHistory(@Param("address") address: string, @Query("page") page = "1", @Query("pageSize") pageSize = "25") {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");

    const pageNumber = Number(page) || 1;
    const pageSizeNumber = Number(pageSize) || 25;
    return this.solversService.getSlashHistory(address, pageNumber, pageSizeNumber);
  }

  @Post(":address/slashes/:slashId/dispute")
  async submitDispute(
    @Param("address") address: string,
    @Param("slashId") slashId: string,
    @Body() dto: { reason: string; evidenceReference?: string; signature: string },
  ) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");

    verifyStellarSignature(
      address,
      buildDisputeMessage(slashId, address, dto.reason),
      dto.signature,
    );

    const record = await this.solversService.submitDispute(
      address,
      slashId,
      dto.reason,
      dto.evidenceReference,
    );
    if (!record) throw new NotFoundException("Slash record not found");
    return record;
  }

  @Post(":address/slashes/:slashId/dispute/resolve")
  async resolveDispute(
    @Param("address") address: string,
    @Param("slashId") slashId: string,
    @Body() dto: { resolution: "resolved-upheld" | "resolved-reversed"; reviewer?: string; note?: string },
  ) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");

    const record = await this.solversService.resolveDispute(
      address,
      slashId,
      dto.resolution,
      dto.reviewer,
      dto.note,
    );
    if (!record) throw new NotFoundException("Slash record not found");
    return record;
  }

  @Post(":address/deregister")
  async deregisterSolver(@Param("address") address: string) {
    const solver = await this.solversService.deregister(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return {
      ...solver,
      withdrawalStatus: "pending",
      withdrawalRequestedAt: Math.floor(Date.now() / 1000),
    };
  }

  @Post(":address/deactivate")
  async deactivate(@Param("address") address: string) {
    const solver = await this.solversService.deactivate(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return solver;
  }

  @Post(":address/reactivate")
  async reactivate(@Param("address") address: string) {
    const solver = await this.solversService.reactivate(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return solver;
  }

  private normalizeWindow(window?: string): LeaderboardWindow {
    const normalized = (window ?? "all").toLowerCase();
    if (normalized === "all" || normalized === "24h" || normalized === "7d" || normalized === "30d") {
      return normalized as LeaderboardWindow;
    }
    throw new BadRequestException("Unsupported leaderboard window. Choose 24h, 7d, 30d, or all.");
  }
}
