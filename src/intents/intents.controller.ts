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
import {
  ApiTags,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiBadRequestResponse,
  ApiTooManyRequestsResponse,
  ApiOperation,
} from "@nestjs/swagger";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { CHAIN_DEADLINE_DEFAULTS, DEFAULT_DEADLINE_SECONDS } from "../config/configuration";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { UserThrottlerGuard } from "./user-throttler.guard";
import {
  verifyStellarSignature,
  buildCancelMessage,
  buildFillMessage,
} from "../common/stellar-signature";
import { SupportedChain } from "./intents.types";

@ApiTags("intents")
@Controller("api/v1/intents")
export class IntentsController {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
    private readonly tokensService: TokensService,
    private readonly routingService: RoutingService,
  ) {}

  @Get()
  @ApiBadRequestResponse({ description: "Invalid limit or offset" })
  async list(@Query() dto: ListIntentsDto) {
    let intents = await this.intentsService.getAll();

    if (dto.state) intents = intents.filter((i) => i.state === dto.state);
    if (dto.user) intents = intents.filter((i) => i.user.toLowerCase() === dto.user!.toLowerCase());
    if (dto.chain) intents = intents.filter((i) => i.srcChain === dto.chain);

    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = intents.slice(offset, offset + limit);
    return { intents: page, total: intents.length, limit, offset };
  }

  @Get("open")
  async listOpen() {
    const open = await this.intentsService.getByState("open");
    return { intents: open, count: open.length };
  }

  @Get("user/:address")
  async listByUser(@Param("address") address: string) {
    const intents = await this.intentsService.getByUser(address);
    return { intents, count: intents.length };
  }

  @Get(":id")
  @ApiNotFoundResponse({ description: "Intent not found" })
  async getOne(@Param("id") id: string) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    return intent;
  }

  /**
   * GET /api/v1/intents/:id/audit
   *
   * Returns the full state-transition history for an intent, oldest-first.
   * Issue #217 — backs the in-memory audit trail with a persistent DB table
   * (intent_audit_log) so the log survives restarts and is independently
   * queryable (see DATABASE_INDEXES.md section 3 and the runbooks that depend
   * on this trail: docs/runbooks/onchain-cutover.md, RUNBOOK_BACKUP_RESTORE.md).
   */
  @Get(":id/audit")
  @ApiOperation({
    summary: "Get audit trail for an intent",
    description:
      "Returns the full state-transition history for an intent ordered oldest-first. " +
      "Each entry records the state the intent moved into, who triggered it, and why.",
  })
  @ApiOkResponse({
    description: "Audit trail for the intent",
    schema: {
      type: "object",
      properties: {
        intentId: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string", format: "date-time" },
              toState: { type: "string" },
              actor: { type: "string" },
              reason: { type: "string" },
              metadata: { type: "object", nullable: true },
            },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: "Intent not found" })
  getAudit(@Param("id") id: string) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    const entries = this.intentsService.getAuditLog(id);
    return { intentId: id, entries };
  }

  /**
   * GET /api/v1/intents/:id/quote
   *
   * Returns the persisted best quote for an intent (the quotedDstAmount stored
   * on the intent after a POST /quote call with intentId).
   */
  @Get(":id/quote")
  @ApiOkResponse({ description: "Persisted quote for the intent" })
  @ApiNotFoundResponse({ description: "Intent not found or no quote persisted" })
  getPersistedQuote(@Param("id") id: string) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (!intent.quotedDstAmount) throw new NotFoundException("No quote persisted for this intent");
    return { intentId: id, quotedDstAmount: intent.quotedDstAmount };
  }

  /**
   * Issue #44 — global IP throttle already applied via AppModule guard.
   * Issue #45 — additionally throttle per dto.user: 10 creates / 60 s.
   */
  @Post()
  @UseGuards(UserThrottlerGuard)
  @ApiTooManyRequestsResponse({
    description:
      "Rate limit exceeded — max 10 intent creations per user per 60 s (or 100 req/min per IP globally)",
  })
  @ApiBadRequestResponse({ description: "Invalid request body" })
  async create(@Body() dto: CreateIntentDto) {
    const now = Math.floor(Date.now() / 1000);

    // #219: use typed resolveToken instead of ad-hoc duck-typed any casts
    const srcToken = this.tokensService.resolveSrcToken(
      dto.srcChain as SupportedChain,
      dto.srcTokenAddress,
    );
    const dstToken = this.tokensService.resolveDstToken(dto.dstTokenContract);

    const intent = await this.intentsService.create(
      {
        user: dto.user,
        srcChain: dto.srcChain,
        srcToken: {
          address: dto.srcTokenAddress,
          symbol: dto.srcTokenSymbol,
          name: dto.srcTokenSymbol,
          decimals: dto.srcTokenDecimals,
          chain: dto.srcChain,
          priceUSD: srcToken?.priceUSD,
        },
        srcAmount: dto.srcAmount,
        dstToken: {
          contract: dto.dstTokenContract,
          symbol: dto.dstTokenSymbol,
          decimals: dto.dstTokenDecimals,
          priceUSD: dstToken?.priceUSD,
        },
        minDstAmount: dto.minDstAmount,
        deadline: dto.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[dto.srcChain] ?? DEFAULT_DEADLINE_SECONDS),
      },
      dto.idempotencyKey,
    );
    this.intentsGateway.broadcast({ type: "intent_created", intent });
    return intent;
  }

  @Post(":id/accept")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in open state" })
  @ApiGoneResponse({ description: "Intent has expired" })
  @ApiForbiddenResponse({ description: "Solver not registered or inactive" })
  async accept(@Param("id") id: string, @Body() dto: AcceptIntentDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      await this.intentsService.update(id, { state: "expired" });
      throw new GoneException("Intent has expired");
    }

    const solver = await this.solversService.get(dto.solver);
    if (!solver?.isActive) {
      throw new ForbiddenException("Solver not registered or inactive");
    }
    if (!solver.bondAmount || BigInt(solver.bondAmount) <= 0n) {
      throw new ForbiddenException("Solver has insufficient bond");
    }

    const updated = await this.intentsService.acceptIfOpen(id, dto.solver);
    if (!updated) {
      const current = await this.intentsService.get(id);
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot accept`);
    }

    this.intentsGateway.broadcast({
      type: "intent_accepted",
      intentId: id,
      solver: dto.solver,
    });
    return updated;
  }

  @Post(":id/fill")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in accepted state" })
  @ApiForbiddenResponse({ description: "Wrong solver for this intent" })
  @ApiGoneResponse({ description: "Fill window has expired" })
  @ApiBadRequestResponse({ description: "Fill amount below minimum" })
  async fill(@Param("id") id: string, @Body() dto: FillIntentDto) {
    const intent = await this.intentsService.get(id);
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

    const updated = await this.intentsService.fillIfAccepted(id, dto.solver, {
      filledAt: now,
      fillAmount: dto.fillAmount,
      txHash: dto.txHash,
    });
    if (!updated) {
      const current = await this.intentsService.get(id);
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
  async cancel(@Param("id") id: string, @Body() dto: CancelIntentDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.user.toLowerCase() !== dto.user.toLowerCase()) {
      throw new ForbiddenException("Unauthorized");
    }
    if (intent.state !== "open") {
      throw new ConflictException(`Cannot cancel intent in state: ${intent.state}`);
    }

    // Verify the user controls the claimed address
    verifyStellarSignature(dto.user, buildCancelMessage(id), dto.signature);

    const updated = await this.intentsService.update(id, { state: "cancelled" });

    // Audit trail (issue #217 / #62): record who cancelled and when.
    this.intentsService.appendAuditEntry(id, "cancelled", dto.user, "user cancelled");

    this.intentsGateway.broadcast({ type: "intent_cancelled", intentId: id });
    return updated;
  }

  /**
   * Issue #44 — document 429 on quote too, since it's under the global guard.
   * Issue #220 — routes are now computed via RoutingService and attached to each quote.
   */
  @Post("quote")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded — max 20 quote requests per 60 s per IP",
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  async quote(@Body() dto: QuoteRequestDto): Promise<QuoteResponseDto> {
    // Security fix: quote() is intentionally unauthenticated for price
    // discovery, but when dto.intentId is supplied we persist quotedDstAmount
    // onto that intent. Without validation, any caller who knows an intent's
    // UUID (public — returned from list/create and broadcast over the WS
    // feed) could overwrite quotedDstAmount with a value computed from an
    // arbitrary, unrelated token pair/amount. We keep this endpoint
    // ownership-agnostic (no signature required, matching its public
    // price-discovery role) but require the request's src/dst token and
    // amount to strictly match the target intent's stored fields, rejecting
    // any mismatch. Requiring proof of ownership was considered but rejected:
    // it would mean adding signature verification to this endpoint, which is
    // explicitly out of scope and inconsistent with quote() remaining public.
    let targetIntent: Awaited<ReturnType<typeof this.intentsService.get>> = undefined;
    if (dto.intentId) {
      targetIntent = await this.intentsService.get(dto.intentId);
      if (!targetIntent) {
        throw new NotFoundException("Intent not found");
      }
      const mismatched =
        targetIntent.srcChain !== dto.srcChain ||
        targetIntent.srcToken?.address?.toLowerCase() !== (dto.srcTokenAddress ?? "").toLowerCase() ||
        targetIntent.dstToken?.contract?.toLowerCase() !== (dto.dstTokenContract ?? "").toLowerCase() ||
        targetIntent.srcAmount !== dto.srcAmount;
      if (mismatched) {
        throw new BadRequestException(
          "Quote request does not match the target intent's srcChain/srcToken/dstToken/srcAmount",
        );
      }
    }

    const solvers = this.solversService.getAll().filter((s) => s.isActive);

    // #219: use typed resolveSrcToken / resolveDstToken — no more any casts
    const srcToken = this.tokensService.resolveSrcToken(
      dto.srcChain as SupportedChain,
      dto.srcTokenAddress ?? "",
    );
    const dstToken = this.tokensService.resolveDstToken(dto.dstTokenContract ?? "");

    const srcAmountBigInt = BigInt(dto.srcAmount);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dstPriceUSD: number = (dstToken as any)?.priceUSD ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcPriceUSD: number = (srcToken as any)?.priceUSD ?? dstPriceUSD;

    const quotes = solvers
      .map((solver) => {
        // Issue #118: weight variance by solver performance history.
        const totalFills = solver.fillsCompleted + solver.fillsFailed;
        const successRate = totalFills > 0 ? solver.fillsCompleted / totalFills : 0.5;
        const fillCountScore = Math.min(solver.fillsCompleted / 100, 1);
        const perfScore = successRate * 0.7 + fillCountScore * 0.3;
        const variancePct = (1 - perfScore) * 0.008;
        const varianceScaled = Math.round(1000 * (1 - variancePct));
        const dstAmount = (srcAmountBigInt * BigInt(varianceScaled)) / BigInt(1000);
        const fee = (dstAmount * BigInt(5)) / BigInt(10000); // 0.05%

        // Issue #126: compute USD fee total and price impact.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feeUnits = Number(fee) / Math.pow(10, (dstToken as any)?.decimals ?? 7);
        const totalFeesUSD = feeUnits * dstPriceUSD;
        const srcUnits = Number(srcAmountBigInt) / Math.pow(10, srcToken?.decimals ?? 7);
        const dstUnits = Number(dstAmount) / Math.pow(10, dstToken?.decimals ?? 7);
        const priceImpact =
          srcPriceUSD > 0 && dstPriceUSD > 0
            ? Math.max(0, 1 - (dstUnits * dstPriceUSD) / (srcUnits * srcPriceUSD))
            : 0;

        // #220: attach a computed route to each solver quote.
        // Build minimal TokenInfo objects for routing (uses resolved data when available).
        const srcTokenInfo = {
          address: dto.srcTokenAddress ?? "",
          symbol: dto.srcTokenSymbol,
          name: srcToken?.name ?? dto.srcTokenSymbol,
          decimals: srcToken?.decimals ?? 18,
          chain: (dto.srcChain as SupportedChain) ?? "ethereum",
          priceUSD: srcToken?.priceUSD,
        };
        const dstTokenInfo = {
          address: dstToken?.contract ?? dto.dstTokenContract ?? "",
          symbol: dto.dstTokenSymbol,
          name: dstToken?.name ?? dto.dstTokenSymbol,
          decimals: dstToken?.decimals ?? 7,
          chain: "stellar" as SupportedChain,
          priceUSD: dstToken?.priceUSD,
        };

        // Try a direct route; fall back to a two-hop via USDC intermediate when
        // a direct solver path is not viable (different base tokens).
        const route = this.routingService.buildRoute(srcTokenInfo, dstTokenInfo, solver.address, {
          totalFeesUSD,
          priceImpact,
          estimatedFillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
        });

        return {
          solver: solver.address,
          solverName: solver.name,
          dstAmount: dstAmount.toString(),
          fee: fee.toString(),
          fillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          totalFeesUSD,
          priceImpact,
          route,
        };
      })
      .sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

    if (dto.intentId && targetIntent && quotes.length > 0) {
      await this.intentsService.update(dto.intentId, { quotedDstAmount: quotes[0].dstAmount });
    }

    const best = quotes[0] ?? null;
    return {
      quotes,
      bestQuote: best,
      srcChain: dto.srcChain,
      srcTokenSymbol: dto.srcTokenSymbol,
      srcAmount: dto.srcAmount,
      dstTokenSymbol: dto.dstTokenSymbol,
      estimatedFillTime: best?.fillTime ?? 0,
      totalFeesUSD: best?.totalFeesUSD ?? 0,
      priceImpact: best?.priceImpact ?? 0,
    };
  }
}
