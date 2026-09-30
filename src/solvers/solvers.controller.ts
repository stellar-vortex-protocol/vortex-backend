import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { IntentsService } from "../intents/intents.service";
import { IntentCapabilityIndex } from "../intents/solver-intent-matcher";
import { SUPPORTED_CHAINS, SupportedChain } from "../intents/intents.types";
import { ListIntentsDto } from "../intents/dto/list-intents.dto";
import {
  buildDisputeMessage,
  buildRegisterMessage,
  buildSolverStatusMessage,
  buildUpdateSolverMessage,
  verifyStellarSignature,
} from "../common/stellar-signature";
import { isCanaryIntent } from "../common/canary";
import { AppConfig } from "../config/configuration";
import { SolversService, LeaderboardWindow } from "./solvers.service";
import { ListIntentsDto } from "../intents/dto/list-intents.dto";
import { AppConfig } from "../config/configuration";
import { isCanaryIntent } from "../common/canary";
import { IntentCapabilityIndex } from "../intents/solver-intent-matcher";
import { RegisterSolverDto } from "./dto/register-solver.dto";
import { UpdateSolverDto } from "./dto/update-solver.dto";
import { UpdateSolverStatusDto } from "./dto/update-solver-status.dto";
import { SolverCredentialService } from "../auth/solver-credentials/solver-credential.service";

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
    private readonly intentIndex: IntentCapabilityIndex,
    private readonly credentialService: SolverCredentialService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.canary = new Set(config.get("canaryAddresses", { infer: true }) ?? []);
  }

  /** Canary addresses (issue #496) — excluded from every leaderboard. */
  private readonly canary: ReadonlySet<string>;

  @Post()
  async register(@Body() dto: RegisterSolverDto) {
    verifyStellarSignature(dto.address, buildRegisterMessage(dto.address), dto.proofSignature);

    const onchainEnabled = (process.env.ONCHAIN_INTENTS_ENABLED ?? "false") === "true";

    if (onchainEnabled) {
      // Issue #399: when on-chain intents are enabled, POST /solvers is a
      // metadata-only endpoint.  Bond amount is authoritative on-chain; the
      // REST endpoint may not set it.  Supported chains/tokens and name are
      // still accepted and merged into any existing record.
      const existing = await this.solversService.get(dto.address);
      if (existing) {
        // Update metadata fields only — bond unchanged.
        return this.solversService.register({
          address: dto.address,
          name: dto.name,
          bondAmount: existing.bondAmount, // preserve on-chain bond
          avgFillTime: dto.avgFillTime,
          isActive: existing.isActive,
          supportedChains: dto.supportedChains,
          supportedTokens: dto.supportedTokens,
        });
      }
      // First-time metadata registration (bond will be set by on-chain event).
      return this.solversService.register({
        address: dto.address,
        name: dto.name,
        bondAmount: "0", // bond is always set by chain events when ONCHAIN_INTENTS_ENABLED
        avgFillTime: dto.avgFillTime,
        isActive: true,
        supportedChains: dto.supportedChains,
        supportedTokens: dto.supportedTokens,
      });
    }

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
    const solvers = (await this.solversService.getAll()).filter((s) => !this.canary.has(s.address));
    const intents = (await this.intentsService.getAll()).filter((i) => !isCanaryIntent(i, this.canary));
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
    const solvers = (await this.solversService.getAll())
      .filter((s) => !this.canary.has(s.address))
      .sort((a, b) => b.fillsCompleted - a.fillsCompleted);
    return { solvers, count: solvers.length };
  }

  @Get(":address/eligible-intents")
  async getEligibleIntents(@Param("address") address: string, @Query() dto: ListIntentsDto) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");
    if (!solver.isActive) throw new ForbiddenException("Solver is not active");

    // Use the capability index for O(supported-chains × supported-tokens)
    // lookup instead of scanning all open intents (issue #436).
    const eligible = this.intentIndex.getEligibleFor(solver);

    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = eligible.slice(offset, offset + limit);
    return { intents: page, total: eligible.length, count: eligible.length, limit, offset };
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
  async deregisterSolver(@Param("address") address: string, @Body() dto: UpdateSolverStatusDto) {
    verifyStellarSignature(address, buildSolverStatusMessage("deregister", address), dto.signature);

    const solver = await this.solversService.deregister(address);
    if (!solver) throw new NotFoundException("Solver not found");
    // Issue #443 — instantly disable every credential of the deregistered solver.
    await this.credentialService.disableAllForSolver(address);
    return {
      ...solver,
      withdrawalStatus: "pending",
      withdrawalRequestedAt: Math.floor(Date.now() / 1000),
    };
  }

  @Post(":address/deactivate")
  async deactivate(@Param("address") address: string, @Body() dto: UpdateSolverStatusDto) {
    verifyStellarSignature(address, buildSolverStatusMessage("deactivate", address), dto.signature);

    const solver = await this.solversService.deactivate(address);
    if (!solver) throw new NotFoundException("Solver not found");
    // Issue #443 — instantly disable every credential of the deactivated solver.
    await this.credentialService.disableAllForSolver(address);
    return solver;
  }

  @Post(":address/reactivate")
  async reactivate(@Param("address") address: string, @Body() dto: UpdateSolverStatusDto) {
    verifyStellarSignature(address, buildSolverStatusMessage("reactivate", address), dto.signature);
    const solver = await this.solversService.reactivate(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return solver;
  }

  /**
   * PATCH /api/v1/solvers/:address — issue #273.
   *
   * Partial update of the solver's *mutable* profile fields. Requires an
   * Ed25519 signature over `update-solver:<address>` from the solver's own
   * key, so a third party cannot rewrite another solver's listing.
   *
   * Immutable fields (bond, fill counters, volume, registeredAt, isActive) are
   * not present on `UpdateSolverDto`, so the global
   * `ValidationPipe({ whitelist: true })` strips them from the body before the
   * handler runs — they are silently ignored rather than rejected.
   */
  @Patch(":address")
  @ApiOperation({
    summary: "Update a solver's mutable profile fields",
    description:
      "Partial update of name, supportedChains, supportedTokens and avgFillTime. " +
      "Requires an Ed25519 signature over the message `update-solver:<address>` " +
      "produced by the solver's own key. Array fields are replaced wholesale. " +
      "Immutable fields are silently ignored.",
  })
  @ApiNotFoundResponse({ description: "Solver not found" })
  async update(@Param("address") address: string, @Body() dto: UpdateSolverDto) {
    verifyStellarSignature(address, buildUpdateSolverMessage(address), dto.signature);

    const updated = await this.solversService.update(address, {
      name: dto.name,
      avgFillTime: dto.avgFillTime,
      supportedChains: dto.supportedChains,
      supportedTokens: dto.supportedTokens,
    });

    if (!updated) throw new NotFoundException("Solver not found");
    return updated;
  }


  private normalizeWindow(window?: string): LeaderboardWindow {
    const normalized = (window ?? "all").toLowerCase();
    if (normalized === "all" || normalized === "24h" || normalized === "7d" || normalized === "30d") {
      return normalized as LeaderboardWindow;
    }
    throw new BadRequestException("Unsupported leaderboard window. Choose 24h, 7d, 30d, or all.");
  }
}
