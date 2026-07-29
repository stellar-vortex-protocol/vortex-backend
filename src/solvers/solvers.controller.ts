import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SolversService } from "./solvers.service";

@ApiTags("solvers")
@Controller("api/v1/solvers")
export class SolversController {
  constructor(private readonly solversService: SolversService) {}

  @Get()
  getLeaderboard() {
    const solvers = [...this.solversService.getAll()].sort(
      (a, b) => b.fillsCompleted - a.fillsCompleted,
    );
    return { solvers, count: solvers.length };
  }

  @Get(":address")
  getSolver(@Param("address") address: string) {
    const solver = this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return solver;
  }

  @Get(":address/stats")
  getSolverStats(@Param("address") address: string) {
    const solver = this.solversService.get(address);
    if (!solver) throw new NotFoundException("Solver not found");

    const total = solver.fillsCompleted + solver.fillsFailed;
    const successRate = total > 0 ? solver.fillsCompleted / total : 0;
    const ageDays = Math.max(
      0,
      (Date.now() / 1000 - solver.registeredAt) / 86400,
    );
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
  deregisterSolver(@Param("address") address: string) {
    const solver = this.solversService.deregister(address);
    if (!solver) throw new NotFoundException("Solver not found");
    return { ...solver, withdrawalStatus: "pending" };
  }
}
