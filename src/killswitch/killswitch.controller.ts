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
import {
  ApproveResumeDto,
  PauseKillSwitchDto,
  PreviewKillSwitchDto,
  ScheduleKillSwitchDto,
} from "./dto/killswitch.dto";
import { OperatorGuard, OperatorRequest } from "./operator.guard";

/**
 * Operator-facing kill-switch API (issue #477).
 *
 * Separate from the public API surface and guarded by {@link OperatorGuard} so
 * the emergency controls are never reachable with a normal client credential.
 */
@ApiTags("ops/killswitch")
@UseGuards(OperatorGuard)
@Controller({ path: "ops/killswitch", version: "1" })
export class KillSwitchController {
  constructor(private readonly killSwitch: KillSwitchService) {}

  @Get()
  @ApiOperation({
    summary: "Current kill-switch state, propagation health and scheduled maintenance windows.",
  })
  @ApiOkResponse({
    description:
      "Ad hoc pauses plus upcoming and currently-active scheduled maintenance windows.",
  })
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

  @Post("schedule")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Schedule a one-shot maintenance window. Activates at scheduledAt and auto-resumes at autoResumeAt without a two-operator approval.",
  })
  @ApiOkResponse({ description: "The scheduled maintenance window that was created." })
  schedule(@Body() dto: ScheduleKillSwitchDto, @Req() request: OperatorRequest) {
    return this.killSwitch.scheduleWindow({
      scope: dto.scope,
      chain: dto.chain,
      token: dto.token,
      operation: dto.operation,
      reasonCode: dto.reasonCode,
      reason: dto.reason,
      scheduledAt: dto.scheduledAt,
      autoResumeAt: dto.autoResumeAt,
      // Identity comes from the authenticated operator, never the body.
      activatedBy: request.operator ?? "operator",
    });
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Estimate the blast radius of a hypothetical pause without activating anything (read-only).",
  })
  @ApiOkResponse({
    description:
      "Estimated affected requests over the recent window, the matched chain, and other active switches that would also govern the same requests.",
  })
  preview(@Body() dto: PreviewKillSwitchDto) {
    return this.killSwitch.previewPause({
      scope: dto.scope,
      chain: dto.chain,
      token: dto.token,
      operation: dto.operation,
      windowSeconds: dto.windowSeconds,
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
