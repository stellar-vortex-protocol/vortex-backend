import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { FeesService, type IntegratorStatement } from "./fees.service";
import { AdminApiKeyGuard } from "../auth/admin-api-key.guard";

/** Read-side integrator payout statements (issue #623). */
@Controller("api/v1/fees/integrators")
@UseGuards(AdminApiKeyGuard)
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get(":integratorId/statement")
  getStatement(
    @Param("integratorId") integratorId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): IntegratorStatement {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(0);
    return this.fees.getIntegratorStatement(integratorId, fromDate, toDate);
  }
}
