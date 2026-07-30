import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiTooManyRequestsResponse } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiBadRequestResponse,
} from "@nestjs/swagger";
import { ApiTags, ApiOkResponse } from "@nestjs/swagger";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";
import { UserThrottlerGuard } from "./user-throttler.guard";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";

@ApiTags("intents")
@Controller("api/v1/intents")
export class IntentsController {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  @Get()
  list(@Query() dto: ListIntentsDto) {
  @ApiBadRequestResponse({ description: "Invalid limit or offset" })
  list(
    @Query("state") state?: string,
    @Query("user") user?: string,
    @Query("chain") chain?: string,
    @Query("limit") limitRaw = "20",
    @Query("offset") offsetRaw = "0",
  ) {
    let intents = this.intentsService.getAll();

    if (dto.state) intents = intents.filter((i) => i.state === dto.state);
    if (dto.user) intents = intents.filter((i) => i.user.toLowerCase() === dto.user.toLowerCase());
    if (dto.chain) intents = intents.filter((i) => i.srcChain === dto.chain);

    const limit = Math.min(dto.limit, 100);
    const offset = dto.offset;
    const limit = parseInt(limitRaw, 10);
    if (limit > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }
    const offset = parseInt(offsetRaw, 10);
    const page = intents.slice(offset, offset + limit);

    return { intents: page, total: intents.length, limit, offset };
  }

  @Get("open")
  listOpen() {
    const open = this.intentsService.getByState("open");
    return { intents: open, count: open.length };
  }

  @Get("user/:address")
  listByUser(@Param("address") address: string) {
    const intents = this.intentsService.getByUser(address);
    return { intents, count: intents.length };
  }

  @Get(":id")
  @ApiNotFoundResponse({ description: "Intent not found" })
  getOne(@Param("id") id: string) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    return intent;
  }

  /**
   * Issue #44 — global IP throttle already applied via AppModule guard.
   * Issue #45 — additionally throttle per dto.user: 10 creates / 60 s.
   */
  @Post()
  @UseGuards(UserThrottlerGuard)
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded — max 10 intent creations per user per 60 s (or 100 req/min per IP globally)",
  })
  @Get(":id/quote")
  getQuote(@Param("id") id: string) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (!intent.quotedDstAmount) {
      throw new NotFoundException("No quote found for this intent");
    }
    return {
      intentId: intent.intentId,
      quotedDstAmount: intent.quotedDstAmount,
    };
  }

  @Post()
  @ApiBadRequestResponse({ description: "Invalid request body" })
  create(@Body() dto: CreateIntentDto) {
  async create(@Body() dto: CreateIntentDto) {
    const now = Math.floor(Date.now() / 1000);
    const intent = await this.intentsService.create({
      user: dto.user,
      srcChain: dto.srcChain,
      srcToken: {
        address: dto.srcTokenAddress,
        symbol: dto.srcTokenSymbol,
        name: dto.srcTokenSymbol,
        decimals: dto.srcTokenDecimals,
        chain: dto.srcChain,
      },
      srcAmount: dto.srcAmount,
      dstToken: {
        contract: dto.dstTokenContract,
        symbol: dto.dstTokenSymbol,
        decimals: dto.dstTokenDecimals,
      },
      minDstAmount: dto.minDstAmount,
      deadline: dto.deadline ?? now + 1800,
    }, dto.idempotencyKey);
    this.intentsGateway.broadcast({ type: "intent_created", intent });
    return intent;
  }

  @Post(":id/accept")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in open state" })
  @ApiGoneResponse({ description: "Intent has expired" })
  @ApiForbiddenResponse({ description: "Solver not registered or inactive" })
  accept(@Param("id") id: string, @Body() dto: AcceptIntentDto) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      this.intentsService.update(id, { state: "expired" });
      throw new GoneException("Intent has expired");
    }

    const solver = this.solversService.get(dto.solver);
    if (!solver?.isActive) {
      throw new ForbiddenException("Solver not registered or inactive");
    }

    const updated = this.intentsService.acceptIfOpen(id, dto.solver);
    if (!updated) {
      const current = this.intentsService.get(id);
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot accept`);
    }

    this.intentsGateway.broadcast({ type: "intent_accepted", intentId: id, solver: dto.solver });
    return updated;
  }

  @Post(":id/fill")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in accepted state" })
  @ApiForbiddenResponse({ description: "Wrong solver for this intent" })
  @ApiGoneResponse({ description: "Fill window has expired" })
  @ApiBadRequestResponse({ description: "Fill amount below minimum" })
  fill(@Param("id") id: string, @Body() dto: FillIntentDto) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      throw new GoneException("Fill window has expired");
    }

    // Verify the solver controls the claimed address
    verifyStellarSignature(dto.solver, buildFillMessage(id, dto.solver), dto.signature);

    const fillAmount = BigInt(dto.fillAmount);
    let minAmount: bigint;
    try {
      minAmount = BigInt(intent.minDstAmount);
    } catch {
      throw new BadRequestException({
        error: "Data integrity error: intent minDstAmount is not a valid integer",
        intentId: id,
        minDstAmount: intent.minDstAmount,
      });
    }
    if (fillAmount < minAmount) {
      throw new BadRequestException({
        error: "Fill amount below minimum",
        fillAmount: dto.fillAmount,
        minDstAmount: intent.minDstAmount,
      });
    }

    const updated = this.intentsService.fillIfAccepted(id, dto.solver, {
      filledAt: now,
      fillAmount: dto.fillAmount,
      txHash: dto.txHash,
    });
    if (!updated) {
      const current = this.intentsService.get(id);
      if (current?.solver !== dto.solver) {
        throw new ForbiddenException("Wrong solver for this intent");
      }
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot fill`);
    }

    this.intentsGateway.broadcast({
      type: "intent_filled",
      intentId: id,
      solver: dto.solver,
      fillAmount: dto.fillAmount,
    });
    return updated;
  }

  @Post(":id/cancel")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiForbiddenResponse({ description: "Unauthorized" })
  @ApiConflictResponse({ description: "Intent is not in open state" })
  cancel(@Param("id") id: string, @Body() dto: CancelIntentDto) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.user.toLowerCase() !== dto.user.toLowerCase()) throw new ForbiddenException("Unauthorized");
    if (intent.state !== "open") {
      throw new ConflictException(`Cannot cancel intent in state: ${intent.state}`);
    }

    // Verify the user controls the claimed address
    verifyStellarSignature(dto.user, buildCancelMessage(id), dto.signature);

    const updated = this.intentsService.update(id, { state: "cancelled" });

    // Audit trail (issue #62): record who cancelled and when.
    this.intentsService.appendAuditEntry(id, "cancelled", dto.user, "user cancelled");

    this.intentsGateway.broadcast({ type: "intent_cancelled", intentId: id });
    return updated;
  }

  /**
   * Issue #44 — document 429 on quote too, since it's under the global guard.
   */
  @Post("quote")
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded — max 100 req/min per IP globally",
  })
  quote(@Body() dto: QuoteRequestDto) {
  @ApiOkResponse({ type: QuoteResponseDto })
  quote(@Body() dto: QuoteRequestDto): QuoteResponseDto {
    const solvers = this.solversService.getAll().filter((s) => s.isActive);
    const srcAmountBigInt = BigInt(dto.srcAmount);

    const quotes = solvers
      .map((solver) => {
        // Variance: 0-0.8% downside; represented as 992-1000 in 1000ths
        const varianceScaled = 992 + Math.floor(Math.random() * 9); // 992-1000
        const dstAmount = (srcAmountBigInt * BigInt(varianceScaled)) / BigInt(1000);
        const fee = (dstAmount * BigInt(5)) / BigInt(10000); // 0.05%
        return {
          solver: solver.address,
          solverName: solver.name,
          dstAmount: dstAmount.toString(),
          fee: fee.toString(),
          fillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      })
      .sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

    // Persist quoted amount if intentId is provided
    if (dto.intentId && quotes.length > 0) {
      this.intentsService.update(dto.intentId, { quotedDstAmount: quotes[0].dstAmount });
    }

    return {
      quotes,
      bestQuote: quotes[0] ?? null,
      srcChain: dto.srcChain,
      srcTokenSymbol: dto.srcTokenSymbol,
      srcAmount: dto.srcAmount,
      dstTokenSymbol: dto.dstTokenSymbol,
      estimatedFillTime: quotes[0]?.fillTime ?? 0,
    };
  }
}
