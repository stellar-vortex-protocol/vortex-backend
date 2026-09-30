import { Body, Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import {
  AntiGriefingIncident,
  AntiGriefingService,
  AntiGriefingStatus,
} from "./anti-griefing.service";
import { BeginIncidentDto, EndIncidentDto } from "./dto/incident.dto";

/**
 * Operator control plane for the anti-griefing controls (issue #453).
 *
 * The two things an operator needs during an incident: declare a chain outage
 * so legitimate failures stop counting against solvers, and clear a punishment
 * that the data shows was wrong. Every mutation is written to both the
 * service's own audit trail and the shared `admin_audit_log`.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller("admin/anti-griefing")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class AntiGriefingController {
  private readonly logger = new Logger(AntiGriefingController.name);

  constructor(
    private readonly antiGriefing: AntiGriefingService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Get("statuses")
  @ApiOperation({ summary: "Anti-griefing status for every tracked solver" })
  statuses(): { solvers: AntiGriefingStatus[]; count: number } {
    const solvers = this.antiGriefing.getAllStatuses();
    return { solvers, count: solvers.length };
  }

  @Get("audit")
  @ApiOperation({ summary: "Anti-griefing audit trail, newest first" })
  @ApiQuery({ name: "solver", required: false, description: "Restrict to one solver address" })
  @ApiQuery({ name: "limit", required: false, description: "Max entries to return (default 100)" })
  auditLog(
    @Query("solver") solver?: string,
    @Query("limit") limit?: string,
  ): { entries: ReturnType<AntiGriefingService["getAudit"]> } {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return {
      entries: this.antiGriefing.getAudit({
        solver: solver || undefined,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      }),
    };
  }

  @Get("incidents")
  @ApiOperation({ summary: "Declared incidents (open and closed)" })
  listIncidents(): { incidents: AntiGriefingIncident[]; count: number } {
    const incidents = this.antiGriefing.listIncidents();
    return { incidents, count: incidents.length };
  }

  @Post("incidents")
  @HttpCode(201)
  @ApiOperation({
    summary: "Declare an incident: unfilled accepts are not counted while it runs",
    description:
      "Use this before/during a chain outage so that missed fills caused by the " +
      "outage do not escalate solvers. Omit `chain` to cover every chain.",
  })
  async beginIncident(@Body() dto: BeginIncidentDto, @CurrentAdmin() admin: AdminPrincipal) {
    const incident = this.antiGriefing.beginIncident({
      chain: dto.chain ?? null,
      reason: dto.reason,
      actor: admin.id,
    });
    await this.auditAdmin("anti-griefing.incident.open", `incident:${incident.id}`, {
      chain: incident.chain,
      reason: incident.reason,
      startedAt: incident.startedAt,
    }, admin.id, dto.reason);
    return { incident };
  }

  @Post("incidents/:id/end")
  @HttpCode(200)
  @ApiOperation({
    summary: "Close an incident",
    description:
      "Failures detected after the outage may still be excused by passing " +
      "`excludeUntil` (epoch ms) — the sweeper can slash well after a chain recovers.",
  })
  async endIncident(
    @Param("id") id: string,
    @Body() dto: EndIncidentDto,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    const incident = this.antiGriefing.endIncident(id, {
      excludeUntil: dto.excludeUntil,
      actor: admin.id,
    });
    if (!incident) throw new NotFoundException(`Incident ${id} not found or already closed`);
    await this.auditAdmin(
      "anti-griefing.incident.close",
      `incident:${incident.id}`,
      { endedAt: incident.endedAt, excludeUntil: incident.excludeUntil },
      admin.id,
    );
    return { incident };
  }

  @Post("solvers/:address/reset")
  @HttpCode(200)
  @ApiOperation({
    summary: "Clear every anti-griefing control on a solver (break-glass)",
    description:
      "Removes the cooldown/cap/suspension but keeps the rolling window, so the " +
      "evidence the decision was based on is not erased.",
  })
  async resetSolver(@Param("address") address: string, @CurrentAdmin() admin: AdminPrincipal) {
    const before = this.antiGriefing.getStatus(address);
    const after = this.antiGriefing.clear(address, admin.id);
    await this.auditAdmin(
      "anti-griefing.solver.reset",
      `solver:${address}`,
      { before, after },
      admin.id,
    );
    return { solver: after };
  }

  /**
   * Best-effort write to the shared `admin_audit_log`.
   *
   * The service's own ring buffer is the authoritative, always-available trail
   * for these actions; a database outage must not stop an operator from
   * declaring an incident or lifting an unfair suspension, so failures are
   * logged rather than thrown.
   */
  private async auditAdmin(
    action: string,
    target: string,
    after: unknown,
    actor: string,
    reason?: string,
  ): Promise<void> {
    try {
      await this.adminAudit.record({ actor, action, target, after, reason });
    } catch (err) {
      this.logger.warn(
        `[anti-griefing] admin audit write failed for ${action} target=${target}: ` +
          `${err instanceof Error ? err.message : String(err)} (service-local audit still recorded)`,
      );
    }
  }
}
