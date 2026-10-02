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
  UnprocessableEntityException,
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
  ApiServiceUnavailableResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { MAX_OPEN_INTENTS_PER_USER, NewIntentData } from "./intents.service";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { CHAIN_DEADLINE_DEFAULTS, DEFAULT_DEADLINE_SECONDS } from "../config/configuration";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { AmendIntentDto } from "./dto/amend-intent.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { BatchLookupDto } from "./dto/batch-lookup.dto";
import {
  BatchCreateIntentsDto,
  BatchCreateIntentsResponseDto,
} from "./dto/batch-create-intents.dto";
import { BATCH_CREATE_MAX_INTENTS } from "../config/limits.config";
import { UserThrottlerGuard } from "./user-throttler.guard";
import {
  verifyStellarSignature,
  buildAcceptMessage,
  buildAmendMessage,
  buildCancelMessage,
  buildFillMessage,
} from "../common/stellar-signature";
import {
  applyVarianceScale,
  calculateProtocolFee,
  parseBaseUnits,
  toDecimalNumber,
  varianceScaleFromPerfScore,
} from "../common/amount";
import { Intent, SupportedChain } from "./intents.types";
import {
  assertNotPaused,
  KillSwitchGate,
  KillSwitchGuard,
} from "../killswitch/killswitch.guard";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { KillSwitchOperation } from "../killswitch/killswitch.types";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { isCanaryIntent } from "../common/canary";

@ApiTags("intents")
@Controller({ path: "intents", version: "1" })
export class IntentsController {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
    private readonly tokensService: TokensService,
    private readonly routingService: RoutingService,
    private readonly killSwitch: KillSwitchService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.canary = new Set(config.get("canaryAddresses", { infer: true }) ?? []);
  }

  /** Canary addresses (issue #496). */
  private readonly canary: ReadonlySet<string>;

  /**
   * Re-assert the kill-switch hierarchy against a *loaded* intent.
   *
   * `KillSwitchGuard` runs before the handler and can only read the route path
   * and body. For `:id` routes that is not enough to evaluate a chain- or
   * token-scoped pause, so `accept` and `fill` call this once the record is in
   * hand. The global-scope and snapshot-readiness checks are still done by the
   * guard, so this is strictly additional coverage, not a replacement.
   */
  private assertIntentNotPaused(intent: Intent, operation: KillSwitchOperation): void {
    assertNotPaused(
      this.killSwitch,
      {
        chain: intent.srcChain,
        // Prefer the contract address: symbols are not unique within a chain,
        // so a symbol-scoped pause would over-match and an address-scoped one
        // would under-match. Operators pause by address.
        token: intent.srcToken?.address ?? null,
        operation,
      },
      { retryAfterSeconds: 30 },
    );
  }

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
  async listOpen(@Query() dto: ListIntentsDto) {
    const open = await this.intentsService.getByState("open");
    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = open.slice(offset, offset + limit);
    return { intents: page, total: open.length, count: open.length, limit, offset };
  }

  @Get("user/:address")
  async listByUser(@Param("address") address: string, @Query() dto: ListIntentsDto) {
    const intents = await this.intentsService.getByUser(address);
    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = intents.slice(offset, offset + limit);
    return { intents: page, total: intents.length, count: intents.length, limit, offset };
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
  async getAudit(@Param("id") id: string, @Query() dto: ListIntentsDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;
    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const allEntries = this.intentsService.getAuditLog(id);
    const entries = this.intentsService.getAuditLog(id, limit, offset);
    const total = allEntries.length;
    return { intentId: id, entries, total, limit, offset };
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
  async getPersistedQuote(@Param("id") id: string) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (!intent.quotedDstAmount) throw new NotFoundException("No quote persisted for this intent");
    return { intentId: id, quotedDstAmount: intent.quotedDstAmount };
  }

  /**
   * Issue #44 — global IP throttle already applied via AppModule guard.
   * Issue #45 — additionally throttle per dto.user: 10 creates / 60 s.
   */
  @Post()
  @UseGuards(UserThrottlerGuard, KillSwitchGuard)
  @KillSwitchGate({ operation: "create" })
  @ApiTooManyRequestsResponse({
    description:
      "Rate limit exceeded — max 10 intent creations per user per 60 s (or 100 req/min per IP globally)",
  })
  @ApiBadRequestResponse({ description: "Invalid request body" })
  @ApiConflictResponse({
    description: `Open-intent cap reached — a single user may not hold more than ${MAX_OPEN_INTENTS_PER_USER} open/accepted intents simultaneously`,
  })
  async create(@Body() dto: CreateIntentDto) {
    const now = Math.floor(Date.now() / 1000);

    // #219: use typed resolveToken instead of ad-hoc duck-typed any casts.
    // #276: reject unrecognised tokens outright instead of silently creating an
    // intent whose priceUSD defaults to undefined.
    // #473: enforce the per-user open-intent cap as a fast-path rejection.
    // The atomic guarantee lives in the persistence layer (conditional write);
    // this pre-check keeps the common over-cap case cheap without adding a
    // round trip on the happy path.
    const openCount = await this.intentsService.countOpenByUser(dto.user);
    if (openCount >= MAX_OPEN_INTENTS_PER_USER) {
      throw new ConflictException(
        `Open-intent cap reached — max ${MAX_OPEN_INTENTS_PER_USER} open/accepted intents per user`,
      );
    }
    const srcToken = await this.tokensService.resolveSrcTokenOrThrow(
      dto.srcChain as SupportedChain,
      dto.srcTokenAddress,
    );
    const dstToken = await this.tokensService.resolveDstTokenOrThrow(dto.dstTokenContract);

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

  /**
   * POST /api/v1/intents/batch
   *
   * Issue #275 — bounded batch status lookup. Lets a solver bot (or a frontend
   * showing a full history) reconcile a known set of intent IDs against current
   * server state in one call instead of N `GET /:id` requests.
   *
   * `POST` (not `GET`) because the ID list can exceed a comfortable query-string
   * length. Subject to the same global rate limits as every other endpoint —
   * no dedicated tier. Read-only: batch accept/fill/cancel is explicitly out of
   * scope.
   */
  @Post("batch")
  @ApiOperation({
    summary: "Batch-fetch current intent records by ID",
    description:
      "Returns the current record for each supplied intent ID. IDs with no " +
      "matching record are omitted (not individually 404'd). Capped at 100 IDs.",
  })
  @ApiOkResponse({ description: "Records for the found intent IDs, plus a count" })
  @ApiBadRequestResponse({
    description: "intentIds missing, not an array of strings, or exceeds 100 entries",
  })
  async batchLookup(@Body() dto: BatchLookupDto) {
    const intents = await this.intentsService.getMany(dto.intentIds);
    return { intents, count: intents.length };
  }

  /**
   * POST /api/v1/intents/batch-create
   *
   * Issue #429 — Atomic batch intent creation endpoint.
   * Creates up to N intents atomically (all-or-nothing) with per-item validation errors.
   */
  @Post("batch-create")
  @UseGuards(UserThrottlerGuard, KillSwitchGuard)
  @KillSwitchGate({ operation: "create" })
  @ApiOperation({
    summary: "Create multiple intents atomically",
    description:
      "Creates up to 50 intents in a single atomic (all-or-nothing) request. " +
      "If any item fails validation or exceeds open intent limits, zero intents are created " +
      "and per-item errors are reported.",
  })
  @ApiOkResponse({ type: BatchCreateIntentsResponseDto })
  @ApiBadRequestResponse({ description: "Invalid request payload or empty batch" })
  @ApiUnprocessableEntityResponse({ description: "Per-item validation errors or limits exceeded" })
  async batchCreate(@Body() dto: BatchCreateIntentsDto) {
    if (!dto.intents || !Array.isArray(dto.intents) || dto.intents.length === 0) {
      throw new BadRequestException("Intents array must contain at least 1 item");
    }

    if (dto.intents.length > BATCH_CREATE_MAX_INTENTS) {
      throw new BadRequestException(
        `Batch size exceeds maximum allowed limit of ${BATCH_CREATE_MAX_INTENTS}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const items: NewIntentData[] = [];

    for (let i = 0; i < dto.intents.length; i++) {
      const itemDto = dto.intents[i];
      const srcToken = await this.tokensService.resolveSrcTokenOrThrow(
        itemDto.srcChain as SupportedChain,
        itemDto.srcTokenAddress,
      );
      const dstToken = await this.tokensService.resolveDstTokenOrThrow(itemDto.dstTokenContract);

      items.push({
        user: itemDto.user,
        srcChain: itemDto.srcChain,
        srcToken: {
          address: itemDto.srcTokenAddress,
          symbol: itemDto.srcTokenSymbol,
          name: itemDto.srcTokenSymbol,
          decimals: itemDto.srcTokenDecimals,
          chain: itemDto.srcChain,
          priceUSD: srcToken?.priceUSD,
        },
        srcAmount: itemDto.srcAmount,
        dstToken: {
          contract: itemDto.dstTokenContract,
          symbol: itemDto.dstTokenSymbol,
          decimals: itemDto.dstTokenDecimals,
          priceUSD: dstToken?.priceUSD,
        },
        minDstAmount: itemDto.minDstAmount,
        deadline: itemDto.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[itemDto.srcChain] ?? DEFAULT_DEADLINE_SECONDS),
      });
    }

    const result = await this.intentsService.createBatch(items);

    if (result.errors.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: "Batch intent creation failed validation",
        created: [],
        errors: result.errors,
      });
    }

    for (const intent of result.created) {
      this.intentsGateway.broadcast({ type: "intent_created", intent });
    }

    return { created: result.created, errors: [] };
  }

  @Post(":id/accept")
  @UseGuards(KillSwitchGuard)
  @KillSwitchGate({ operation: "accept" })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in open state" })
  @ApiGoneResponse({ description: "Intent has expired" })
  @ApiForbiddenResponse({ description: "Solver not registered or inactive" })
  async accept(@Param("id") id: string, @Body() dto: AcceptIntentDto) {
    // Fast-path snapshot only — guards below are advisory. The atomic
    // decision is the conditional `acceptIfOpen` write (state=open AND
    // deadline > now in SQL), so a concurrent cancel/expiry always wins.
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    // The guard above can only see the path parameter, so it could not know
    // which chain/token this intent belongs to. Re-assert now that the record
    // is loaded, otherwise a chain- or token-scoped pause would not stop
    // accepts. Deliberately placed after the 404 so an unknown id still 404s.
    this.assertIntentNotPaused(intent, "accept");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      // Atomic expiry attempt: never blindly overwrite — an `accepted`
      // intent must slash, never expire (issue #473).
      await this.intentsService.expireIfOpen(id);
      throw new GoneException("Intent has expired");
    }

    // Verify the solver controls the claimed address before it can accept.
    verifyStellarSignature(dto.solver, buildAcceptMessage(id, dto.solver), dto.signature);

    const solver = await this.solversService.get(dto.solver);
    if (!solver?.isActive) {
      throw new ForbiddenException("Solver not registered or inactive");
    }
    if (!solver.bondAmount || BigInt(solver.bondAmount) <= 0n) {
      throw new ForbiddenException("Solver has insufficient bond");
    }
    if (this.solversService.isSuspended(dto.solver)) {
      throw new ForbiddenException("Solver is suspended by an active guardian action");
    }
    // Canary intents pair only with canary solvers (issue #496) so synthetic
    // traffic never affects real solvers' stats or real users' fills.
    if (isCanaryIntent(intent, this.canary) !== this.canary.has(dto.solver)) {
      throw new ForbiddenException("Canary intents may only be accepted by canary solvers, and vice versa");
    }

    const updated = await this.intentsService.acceptIfOpen(id, dto.solver, now);
    if (!updated) {
      const current = await this.intentsService.get(id);
      if (!current) throw new NotFoundException("Intent not found");
      if ((current.deadline ?? 0) <= Math.floor(Date.now() / 1000)) {
        throw new GoneException("Intent has expired");
      }
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot accept`);
    }

    this.intentsService.appendAuditEntry(id, "accepted", dto.solver, "solver accepted", {
      deadline: updated.deadline,
    });
    this.intentsGateway.broadcast({
      type: "intent_accepted",
      intentId: id,
      solver: dto.solver,
    });
    return updated;
  }

  @Post(":id/fill")
  @UseGuards(KillSwitchGuard)
  @KillSwitchGate({ operation: "fill" })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiServiceUnavailableResponse({
    description: "An emergency kill-switch is active for this intent's scope (503 + Retry-After)",
  })
  @ApiConflictResponse({ description: "Intent is not in accepted state" })
  @ApiForbiddenResponse({ description: "Wrong solver for this intent" })
  @ApiGoneResponse({ description: "Fill window has expired" })
  @ApiBadRequestResponse({ description: "Fill amount below minimum" })
  async fill(@Param("id") id: string, @Body() dto: FillIntentDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    // Same reason as in `accept`: the route guard cannot resolve the intent's
    // chain/token from `:id`, so re-assert against the loaded record.
    this.assertIntentNotPaused(intent, "fill");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      throw new GoneException("Fill window has expired");
    }

    // Verify the solver controls the claimed address
    verifyStellarSignature(dto.solver, buildFillMessage(id, dto.solver), dto.signature);

    const fillAmount = parseBaseUnits(dto.fillAmount);
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

    const feeAmount = (BigInt(dto.fillAmount) * 5n) / 10000n;

    const updated = await this.intentsService.fillIfAccepted(id, dto.solver, {
      filledAt: now,
      fillAmount: dto.fillAmount,
      feeAmount: feeAmount.toString(),
      txHash: dto.txHash,
    });
    if (!updated) {
      const current = await this.intentsService.get(id);
      if (current?.solver !== dto.solver) {
        throw new ForbiddenException("Wrong solver for this intent");
      }
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot fill`);
    }

    await this.solversService.recordSuccessfulFill(dto.solver);

    this.intentsService.appendAuditEntry(id, "filled", dto.solver, "solver filled", {
      fillAmount: dto.fillAmount,
      txHash: dto.txHash,
    });
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

    const updated = await this.intentsService.cancelIfOpen(id);
    if (!updated) {
      const current = await this.intentsService.get(id);
      throw new ConflictException(`Cannot cancel intent in state: ${current?.state ?? "unknown"}`);
    }

    // Audit trail (issue #217 / #62): record who cancelled and when.
    this.intentsService.appendAuditEntry(id, "cancelled", dto.user, "user cancelled");

    this.intentsGateway.broadcast({ type: "intent_cancelled", intentId: id });
    return updated;
  }

  /**
   * Issue #569 — amend the terms of an open intent.
   *
   * Replaces `minDstAmount` and `deadline` on an intent that is still `open`
   * and whose deadline has not passed. Both replacement values are covered by
   * the creator's Ed25519 signature (see `buildAmendMessage`), so neither can
   * change without the owner's consent. The write itself goes through
   * `amendIfOpen`, whose state + deadline predicates make it race-free against
   * a concurrent accept, and it deliberately does not bump `version` —
   * widening the user's terms does not compete with solver writes.
   */
  @Post(":id/amend")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiForbiddenResponse({ description: "Unauthorized" })
  @ApiConflictResponse({ description: "Intent is not amendable" })
  async amend(@Param("id") id: string, @Body() dto: AmendIntentDto): Promise<Intent> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.user.toLowerCase() !== dto.user.toLowerCase()) {
      throw new ForbiddenException("Unauthorized");
    }

    // The signature must cover the replacement values themselves, so a
    // tampered minDstAmount or deadline fails verification before any write.
    verifyStellarSignature(
      dto.user,
      buildAmendMessage(id, dto.user, dto.minDstAmount, dto.deadline),
      dto.signature,
    );

    const amended = await this.intentsService.amendIfOpen(id, {
      minDstAmount: dto.minDstAmount,
      deadline: dto.deadline,
    });
    if (!amended) {
      const current = await this.intentsService.get(id);
      throw new ConflictException(`Cannot amend intent in state: ${current?.state ?? "unknown"}`);
    }

    this.intentsService.appendAuditEntry(id, "open", dto.user, "user amended", {
      previousMinDstAmount: intent.minDstAmount,
      minDstAmount: dto.minDstAmount,
      previousDeadline: intent.deadline,
      deadline: dto.deadline,
    });

    return amended;
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
    const solvers = (await this.solversService.getAll()).filter((s) => s.isActive);

    // #219: use typed resolveSrcToken / resolveDstToken — no more any casts.
    // #276: a quote may be requested by symbol alone (no contract/address), but
    // when a token identifier IS supplied it must resolve — otherwise the quote
    // engine would silently substitute a fake $1 price.
    const srcToken = dto.srcTokenAddress
      ? await this.tokensService.resolveSrcTokenOrThrow(
          dto.srcChain as SupportedChain,
          dto.srcTokenAddress,
        )
      : undefined;
    const dstToken = dto.dstTokenContract
      ? await this.tokensService.resolveDstTokenOrThrow(dto.dstTokenContract)
      : undefined;

    const srcAmountBigInt = parseBaseUnits(dto.srcAmount);
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
        const varianceScaled = varianceScaleFromPerfScore(perfScore);
        const dstAmount = applyVarianceScale(srcAmountBigInt, varianceScaled);
        const fee = calculateProtocolFee(dstAmount); // 0.05%

        // Issue #126: compute USD fee total and price impact.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feeUnits = toDecimalNumber(fee, (dstToken as any)?.decimals ?? 7);
        const totalFeesUSD = feeUnits * dstPriceUSD;
        const srcUnits = toDecimalNumber(srcAmountBigInt, srcToken?.decimals ?? 7);
        const dstUnits = toDecimalNumber(dstAmount, dstToken?.decimals ?? 7);
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
      // nosemgrep: no-number-money -- sort comparator on bounded quote diffs only; amounts stay strings elsewhere.
      .sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

    if (dto.intentId && quotes.length > 0) {
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

  /**
   * POST /api/v1/intents/:id/requote
   *
   * Convenience endpoint for re-quoting an already-created intent without
   * resupplying srcChain/srcToken/srcAmount/dstToken — they're read straight
   * off the stored Intent record. Only valid while the intent is "open".
   */
  @Post(":id/requote")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Re-quote an existing open intent using its stored fields" })
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded — max 20 quote requests per 60 s per IP",
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in the open state" })
  async requote(@Param("id") id: string): Promise<QuoteResponseDto> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.state !== "open") {
      throw new ConflictException(
        `Cannot requote intent in state "${intent.state}"; only open intents can be requoted`,
      );
    }

    const solvers = (await this.solversService.getAll()).filter((s) => s.isActive);
    const srcToken = intent.srcToken;
    const dstToken = intent.dstToken;
    const srcAmountBigInt = BigInt(intent.srcAmount);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dstPriceUSD: number = (dstToken as any)?.priceUSD ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcPriceUSD: number = (srcToken as any)?.priceUSD ?? dstPriceUSD;

    const quotes = solvers
      .map((solver) => {
        const totalFills = solver.fillsCompleted + solver.fillsFailed;
        const successRate = totalFills > 0 ? solver.fillsCompleted / totalFills : 0.5;
        const fillCountScore = Math.min(solver.fillsCompleted / 100, 1);
        const perfScore = successRate * 0.7 + fillCountScore * 0.3;
        const variancePct = (1 - perfScore) * 0.008;
        const varianceScaled = Math.round(1000 * (1 - variancePct));
        const dstAmount = (srcAmountBigInt * BigInt(varianceScaled)) / BigInt(1000);
        const fee = (dstAmount * BigInt(5)) / BigInt(10000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feeUnits = Number(fee) / Math.pow(10, (dstToken as any)?.decimals ?? 7);
        const totalFeesUSD = feeUnits * dstPriceUSD;
        const srcUnits = Number(srcAmountBigInt) / Math.pow(10, srcToken?.decimals ?? 7);
        const dstUnits = Number(dstAmount) / Math.pow(10, dstToken?.decimals ?? 7);
        const priceImpact =
          srcPriceUSD > 0 && dstPriceUSD > 0
            ? Math.max(0, 1 - (dstUnits * dstPriceUSD) / (srcUnits * srcPriceUSD))
            : 0;

        const dstTokenInfo = {
          address: dstToken?.contract ?? "",
          symbol: dstToken?.symbol ?? "",
          name: dstToken?.symbol ?? "",
          decimals: dstToken?.decimals ?? 7,
          chain: "stellar" as SupportedChain,
          priceUSD: dstToken?.priceUSD,
        };

        const route = this.routingService.buildRoute(srcToken, dstTokenInfo, solver.address, {
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
      // nosemgrep: no-number-money -- sort comparator on bounded quote diffs only; amounts stay strings elsewhere.
      .sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

    if (quotes.length > 0) {
      await this.intentsService.update(id, { quotedDstAmount: quotes[0].dstAmount });
    }

    const best = quotes[0] ?? null;
    return {
      quotes,
      bestQuote: best,
      srcChain: intent.srcChain,
      srcTokenSymbol: srcToken?.symbol ?? "",
      srcAmount: intent.srcAmount,
      dstTokenSymbol: dstToken?.symbol ?? "",
      estimatedFillTime: best?.fillTime ?? 0,
      totalFeesUSD: best?.totalFeesUSD ?? 0,
      priceImpact: best?.priceImpact ?? 0,
    };
  }
}
