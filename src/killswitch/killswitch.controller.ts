import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { KillSwitchService } from "./killswitch.service";
import { ApproveResumeDto, PauseKillSwitchDto } from "./dto/killswitch.dto";
import { OperatorGuard, OperatorRequest } from "./operator.guard";

/**
 * Operator-facing kill-switch API (issue #477).
 *
 * Separate from the public API surface and guarded by {@link OperatorGuard} so
 * the emergency controls are never reachable with a normal client credential.
 */
@ApiTags("ops/killswitch")
@UseGuards(OperatorGuard)
@Controller("api/v1/ops/killswitch")
export class KillSwitchController {
  constructor(private readonly killSwitch: KillSwitchService) {}

  @Get()
  @ApiOperation({ summary: "Current kill-switch state and propagation health." })
  status() {
    return this.killSwitch.status();
  }

  @Post("pause")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Pause a scope. Effective on every replica within the propagation budget.",
  })
  pause(@Body() dto: PauseKillSwitchDto, @Req() request: OperatorRequest) {
    return this.killSwitch.pause({
      scope: dto.scope,
      chain: dto.chain,
      token: dto.token,
      operation: dto.operation,
      reasonCode: dto.reasonCode,
      reason: dto.reason,
      // Identity comes from the authenticated operator, never the body — the
      // body is attacker-controlled input.
      activatedBy: request.operator ?? "operator",
    });
  }

  @Post("resume/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Approve a resume. Takes effect once two distinct operators have approved.",
  })
  approveResume(@Param("id") id: string, @Body() dto: ApproveResumeDto, @Req() request: OperatorRequest) {
    return this.killSwitch.approveResume({
      id,
      // The approver is the authenticated identity, not a body field: otherwise
      // a single caller could send two approvals under two names and satisfy
      // the two-approval rule alone.
      approver: request.operator ?? "operator",
      approvalsRequired: dto.approvalsRequired ?? 2,
      note: dto.note,
    });
  }
}
