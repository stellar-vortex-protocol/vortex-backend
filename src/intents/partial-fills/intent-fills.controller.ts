import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { isCanaryIntent } from "../../common/canary";
import { bindLogContext } from "../../common/log-context";
import {
  buildReserveMessage,
  buildTrancheFillMessage,
  verifyStellarSignature,
} from "../../common/stellar-signature";
import { assertNotPaused, KillSwitchGate, KillSwitchGuard } from "../../killswitch/killswitch.guard";
import { KillSwitchService } from "../../killswitch/killswitch.service";
import { KillSwitchOperation } from "../../killswitch/killswitch.types";
import { SolversService } from "../../solvers/solvers.service";
import { DestinationPreflightService } from "../../soroban/destination-preflight.service";
import { IntentsService } from "../intents.service";
import { Intent } from "../intents.types";
import { FillTrancheDto } from "../dto/fill-tranche.dto";
import { ReserveTrancheDto } from "../dto/reserve-tranche.dto";
import { PartialFillService } from "./partial-fill.service";

/**
 * Partial-fill endpoints (issue #427).
 *
 * - `POST /intents/:id/reservations` — reserve a tranche of srcAmount.
 * - `POST /intents/:id/reservations/:fillId/fill` — report delivery of it.
 * - `GET  /intents/:id/fills` — tranche list + `fillProgress`.
 *
 * Solver eligibility mirrors the all-or-nothing accept: a registered, active,
 * bonded, unsuspended solver whose Ed25519 signature covers the request, and
 * the same kill-switch and canary rules.
 */
@ApiTags("intents")
@Controller({ path: "intents", version: "1" })
export class IntentFillsController {
  private readonly canary: ReadonlySet<string>;

  constructor(
    private readonly intents: IntentsService,
    private readonly partialFills: PartialFillService,
    private readonly solvers: SolversService,
    private readonly killSwitch: KillSwitchService,
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly destinationPreflight?: DestinationPreflightService,
  ) {
    this.canary = new Set(config.get("canaryAddresses", { infer: true }) ?? []);
  }

  @Get(":id/fills")
  @ApiOperation({ summary: "List partial-fill tranches and progress for an intent" })
  @ApiOkResponse({ description: "{ intentId, allowPartialFill, fillProgress, fills[] }" })
  @ApiNotFoundResponse({ description: "Intent not found" })
  async list(@Param("id") id: string) {
    const intent = await this.load(id);
    const { fills, fillProgress } = await this.partialFills.details(intent);
    return { intentId: id, allowPartialFill: intent.allowPartialFill === true, fillProgress, fills };
  }

  @Post(":id/reservations")
  @UseGuards(KillSwitchGuard)
  @KillSwitchGate({ operation: "accept" })
  @ApiOperation({
    summary: "Reserve a tranche of a partial-fill intent",
    description:
      "Reserves `amount` source base units for the solver until a tranche deadline (fill window, capped at " +
      "the intent deadline). Concurrent reservations are serialised; their sum never exceeds srcAmount.",
  })
  @ApiOkResponse({ description: "{ fill, intent } — the new tranche and the intent with fillProgress" })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiBadRequestResponse({ description: "Amount malformed or below minFillAmount" })
  @ApiConflictResponse({ description: "Not a partial-fill intent, not open, or amount exceeds the remainder" })
  @ApiForbiddenResponse({ description: "Solver not registered, inactive, unbonded or suspended" })
  @ApiGoneResponse({ description: "Intent has expired" })
  @ApiUnprocessableEntityResponse({ description: "Destination can no longer receive the delivery (issue #439)" })
  async reserve(@Param("id") id: string, @Body() dto: ReserveTrancheDto) {
    const intent = await this.load(id);
    this.assertIntentNotPaused(intent, "accept");
    verifyStellarSignature(dto.solver, buildReserveMessage(id, dto.solver, dto.amount), dto.signature);
    await this.assertSolverEligible(intent, dto.solver);
    // Same accept-time destination re-check as the all-or-nothing path.
    await this.destinationPreflight?.assertDeliverable(intent.user, intent.dstToken.contract, intent.minDstAmount, {
      fresh: true,
    });
    return this.partialFills.reserve(intent, dto.solver, dto.amount, Math.floor(Date.now() / 1000));
  }

  @Post(":id/reservations/:fillId/fill")
  @HttpCode(200)
  @UseGuards(KillSwitchGuard)
  @KillSwitchGate({ operation: "fill" })
  @ApiOperation({
    summary: "Fill a reserved tranche",
    description:
      "Records delivery of one tranche. When it is the last open piece of the intent, the intent settles " +
      "to `filled` and `intent_filled` is broadcast with `partial: true`.",
  })
  @ApiOkResponse({ description: "{ fill, intent, settled }" })
  @ApiNotFoundResponse({ description: "Intent or tranche not found" })
  @ApiBadRequestResponse({ description: "dstAmount below the tranche's pro-rata minimum" })
  @ApiConflictResponse({ description: "Tranche already filled or slashed" })
  @ApiForbiddenResponse({ description: "Tranche held by another solver" })
  @ApiGoneResponse({ description: "Tranche fill window has expired" })
  async fill(@Param("id") id: string, @Param("fillId") fillId: string, @Body() dto: FillTrancheDto) {
    const intent = await this.load(id);
    this.assertIntentNotPaused(intent, "fill");
    verifyStellarSignature(dto.solver, buildTrancheFillMessage(id, fillId, dto.solver, dto.dstAmount), dto.signature);
    return this.partialFills.fillTranche(intent, fillId, dto.solver, dto.dstAmount, dto.txHash, Math.floor(Date.now() / 1000));
  }

  private async load(id: string): Promise<Intent> {
    const intent = await this.intents.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    bindLogContext({ intentId: id, chain: intent.srcChain });
    return intent;
  }

  private assertIntentNotPaused(intent: Intent, operation: KillSwitchOperation): void {
    assertNotPaused(
      this.killSwitch,
      { chain: intent.srcChain, token: intent.srcToken?.address ?? null, operation },
      { retryAfterSeconds: 30 },
    );
  }

  private async assertSolverEligible(intent: Intent, address: string): Promise<void> {
    bindLogContext({ solver: address });
    const solver = await this.solvers.get(address);
    if (!solver?.isActive) throw new ForbiddenException("Solver not registered or inactive");
    if (!solver.bondAmount || BigInt(solver.bondAmount) <= 0n) {
      throw new ForbiddenException("Solver has insufficient bond");
    }
    if (this.solvers.isSuspended(address)) {
      throw new ForbiddenException("Solver is suspended by an active guardian action");
    }
    if (isCanaryIntent(intent, this.canary) !== this.canary.has(address)) {
      throw new ForbiddenException("Canary intents may only be reserved by canary solvers, and vice versa");
    }
  }
}
