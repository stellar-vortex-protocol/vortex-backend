import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { SolversService } from "./solvers.service";

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

    return {
      address: solver.address,
      name: solver.name,
      fillsCompleted: solver.fillsCompleted,
      fillsFailed: solver.fillsFailed,
      successRate: parseFloat(successRate.toFixed(4)),
      totalVolume: solver.totalVolume,
      avgFillTime: solver.avgFillTime,
      bondAmount: solver.bondAmount,
    };
  }
}
