import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { verifyStellarSignature, buildDisputeMessage } from "../common/stellar-signature";
import { SolversService } from "../solvers/solvers.service";
import { DisputesService } from "./disputes.service";
import { ReviewerGuard } from "./reviewer.guard";
import { SubmitDisputeDto } from "./dto/submit-dispute.dto";
import { DecideDisputeDto } from "./dto/decide-dispute.dto";

@ApiTags("disputes")
@Controller("api/v1/solvers/disputes")
export class DisputesController {
  constructor(
    private readonly disputesService: DisputesService,
    private readonly solversService: SolversService,
  ) {}

  /** Public, anonymised dispute statistics. */
  @Get("stats")
  @ApiOperation({ summary: "Public anonymised dispute statistics" })
  stats() {
    return this.disputesService.statistics();
  }

  /** Authenticated dispute submission (solver proves control of their key). */
  @Post()
  @ApiOperation({ summary: "File a slash dispute with evidence" })
  async submit(@Body() dto: SubmitDisputeDto) {
    const slash = await this.solversService.getSlash(dto.slashId);
    if (!slash) throw new NotFoundException("Slash not found");

    verifyStellarSignature(
      slash.solver,
      buildDisputeMessage(dto.slashId, slash.solver, dto.reason),
      dto.signature,
    );

    return this.disputesService.submit(slash.solver, {
      slashId: dto.slashId,
      reason: dto.reason,
      evidence: {
        txHashes: dto.evidence.txHashes,
        logs: dto.evidence.logs,
        note: dto.evidence.note,
      },
    });
  }

  @Get()
  @UseGuards(ReviewerGuard)
  @ApiOperation({ summary: "List all disputes (reviewer)" })
  list() {
    return this.disputesService.list();
  }

  @Get(":disputeId")
  @UseGuards(ReviewerGuard)
  @ApiOperation({ summary: "Get a single dispute (reviewer)" })
  get(@Param("disputeId") disputeId: string) {
    return this.disputesService.get(disputeId);
  }

  @Post(":disputeId/review")
  @UseGuards(ReviewerGuard)
  @ApiOperation({ summary: "Move a dispute into review (reviewer)" })
  review(@Param("disputeId") disputeId: string) {
    return this.disputesService.review(disputeId);
  }

  @Post(":disputeId/decide")
  @UseGuards(ReviewerGuard)
  @ApiOperation({ summary: "Decide a dispute (reviewer): upheld or overturned" })
  decide(
    @Param("disputeId") disputeId: string,
    @Headers("x-reviewer-address") reviewer: string,
    @Body() dto: DecideDisputeDto,
  ) {
    return this.disputesService.decide(disputeId, dto.resolution, reviewer, dto.reason);
  }
}
