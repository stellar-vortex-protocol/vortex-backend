import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SolversService } from "./solvers.service";
import { RegisterSolverDto } from "./dto/register-solver.dto";
import { verifyStellarSignature, buildRegisterMessage } from "../common/stellar-signature";

@ApiTags("solvers")
@Controller("api/v1/solvers")
export class SolversController {
  constructor(private readonly solversService: SolversService) {}

  @Post("register")
  register(@Body() dto: RegisterSolverDto) {
    // Prove the caller controls the claimed solver address before registering.
    verifyStellarSignature(dto.address, buildRegisterMessage(dto.address), dto.signature);

    const solver = this.solversService.register({
      address: dto.address,
      name: dto.name,
      bondAmount: dto.bondAmount,
      isActive: dto.isActive ?? false,
      avgFillTime: 0,
      supportedChains: dto.supportedChains,
      supportedTokens: dto.supportedTokens,
    });
    return solver;
  }

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
