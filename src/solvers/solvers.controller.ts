import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { IntentsService } from "../intents/intents.service";
import { ListIntentsDto } from "../intents/dto/list-intents.dto";
import { SolversService, solverSupports } from "./solvers.service";
import { RegisterSolverDto } from "./dto/register-solver.dto";
import { UpdateSolverStatusDto } from "./dto/update-solver-status.dto";
import { verifyStellarSignature, buildSolverStatusMessage } from "../common/stellar-signature";

@ApiTags("solvers")
@Controller("api/v1/solvers")
export class SolversController {
  constructor(
    private readonly solversService: SolversService,
    @Inject(forwardRef(() => IntentsService))
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

  @Get()
  async getLeaderboard() {
    const solvers = (await this.solversService.getAll()).sort(
      (a, b) => b.fillsCompleted - a.fillsCompleted,
    );
    return { solvers, count: solvers.length };
  }

  @Get(":address/eligible-intents")
  async getEligibleIntents(@Param("address") address: string, @Query() dto: ListIntentsDto) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");
    if (!solver.isActive) throw new ForbiddenException("Solver is not active");

    const open = await this.intentsService.getByState("open");
    const eligible = open.filter((intent) =>
      solverSupports(solver, intent.srcChain, intent.srcToken.symbol),
    );

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
  async getSolverStats(@Param("address") address: string) {
    const solver = await this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");

    const total = solver.fillsCompleted + solver.fillsFailed;
    const successRate = total > 0 ? solver.fillsCompleted / total : 0;
    const ageDays = Math.max(0, (Date.now() / 1000 - solver.registeredAt) / 86400);
    const reputationScore = parseFloat(
      (successRate * Math.exp(-ageDays / 180)).toFixed(4),
    );

    return {
      address: solver.address,
      name: solver.name,
      fillsCompleted: solver.fillsCompleted,
      fillsFailed: solver.fillsFailed,
      successRate: parseFloat(successRate.toFixed(4)),
      reputationScore,
      totalVolume: solver.totalVolume,
      avgFillTime: solver.avgFillTime,
      bondAmount: solver.bondAmount,
    };
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
}
