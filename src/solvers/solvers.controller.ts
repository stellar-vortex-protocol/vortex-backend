import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SolversService } from "./solvers.service";
import { RegisterSolverDto } from "./dto/register-solver.dto";

@ApiTags("solvers")
@Controller("api/v1/solvers")
export class SolversController {
  constructor(private readonly solversService: SolversService) {}

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
    return { ...solver, withdrawalStatus: "pending" };
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
