import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  Inject,
  ServiceUnavailableException,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  UnauthorizedException,
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
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { MAX_OPEN_INTENTS_PER_USER } from "./intents.service";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { CHAIN_DEADLINE_DEFAULTS, DEFAULT_DEADLINE_SECONDS } from "../config/configuration";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { FillVerifierService } from "../soroban/fill-verifier.service";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { BatchLookupDto } from "./dto/batch-lookup.dto";
import { UserThrottlerGuard } from "./user-throttler.guard";
import { AbuseDetectorGuard } from "../abuse/abuse-detector.guard";
import { AbuseScoreService } from "../abuse/abuse-score.service";
import {
  verifyStellarSignature,
  buildAcceptMessage,
  buildCancelMessage,
  buildFillMessage,
  INTENT_SIGNATURE_CLOCK_SKEW_SECONDS,
  IntentSignatureContext,
  MAX_INTENT_SIGNATURE_TTL_SECONDS,
} from "../common/stellar-signature";
import { SignatureNonceService } from "../common/signature-nonce.service";
import { EvmSignatureVerifier } from "../common/evm-signature";
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
import { captureTraceparent, ATTR } from "../tracing";
import { trace } from "@opentelemetry/api";
import { MetricsService } from "../metrics/metrics.service";
import { dutchAuctionPrice } from "../auctions/dutch";

interface IntentSignatureProof {
  action: "create" | "accept" | "fill" | "cancel";
  signer: string;
  nonce?: string;
  expiresAt?: number;
}

@ApiTags("intents")
@Controller("api/v1/intents")
export class IntentsController {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
    private readonly tokensService: TokensService,
    private readonly routingService: RoutingService,
    private readonly killSwitch: KillSwitchService,
    private readonly abuseScorer: AbuseScoreService,
    private readonly signatureNonces: SignatureNonceService,
    private readonly evmSignatures: EvmSignatureVerifier,
    config: ConfigService<AppConfig, true>,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
    private readonly fillVerifier: FillVerifierService,
  ) {
    this.canary = new Set(config.get("canaryAddresses", { infer: true }) ?? []);
    this.signatureNetwork = config.get("stellar.network", { infer: true });
    this.legacyStellarSignatures = config.get("legacyStellarSignatures", { infer: true });
    this.nodeEnv = config.get("nodeEnv", { infer: true });
  }

  /** Canary addresses (issue #496). */
  private readonly canary: ReadonlySet<string>;
  private readonly signatureNetwork: AppConfig["stellar"]["network"];
  private readonly legacyStellarSignatures: boolean;
  private readonly nodeEnv: string;

  private verifyIntentSignature(
    action: IntentSignatureProof["action"],
    signer: string,
    signature: string,
    nonce: string | undefined,
    expiresAt: number | undefined,
    legacyMessage: string,
    v2Message: (context: IntentSignatureContext) => string,
  ): IntentSignatureProof {
    if ((nonce === undefined) !== (expiresAt === undefined)) {
      throw new BadRequestException("nonce and expiresAt must be provided together");
    }

    if (nonce === undefined || expiresAt === undefined) {
      if (!this.legacyStellarSignatures) {
        throw new BadRequestException({
          code: "SIGNATURE_V2_REQUIRED",
          message: "A nonce and expiry are required for this signature",
        });
      }
      verifyStellarSignature(signer, legacyMessage, signature);
      return { action, signer };
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      expiresAt + INTENT_SIGNATURE_CLOCK_SKEW_SECONDS < now ||
      expiresAt > now + MAX_INTENT_SIGNATURE_TTL_SECONDS + INTENT_SIGNATURE_CLOCK_SKEW_SECONDS
    ) {
      throw new UnauthorizedException("Signature has expired or exceeds the maximum lifetime");
    }

    verifyStellarSignature(
      signer,
      v2Message({ network: this.signatureNetwork, nonce, expiresAt }),
      signature,
    );
    return { action, signer, nonce, expiresAt };
  }

  private async consumeIntentNonce(proof: IntentSignatureProof): Promise<void> {
    if (proof.nonce === undefined || proof.expiresAt === undefined) {
      this.metrics?.legacyStellarSignatures.inc({ action: proof.action });
      return;
    }
    const expiryWithSkew = proof.expiresAt + INTENT_SIGNATURE_CLOCK_SKEW_SECONDS;
    if (!(await this.signatureNonces.consume(proof.signer, proof.nonce, expiryWithSkew))) {
      throw new ConflictException({
        code: "NONCE_REUSED",
        message: "This signing nonce has already been used",
      });
    }
  }

  private assertEvmSignatureExpiry(expiresAt: number): void {
    const now = Math.floor(Date.now() / 1000);
    if (
      expiresAt + INTENT_SIGNATURE_CLOCK_SKEW_SECONDS < now ||
      expiresAt > now + MAX_INTENT_SIGNATURE_TTL_SECONDS + INTENT_SIGNATURE_CLOCK_SKEW_SECONDS
    ) {
      throw new UnauthorizedException("Signature has expired or exceeds the maximum lifetime");
    }
  }

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
  @ApiBadRequestResponse({ description: "Invalid limit, offset, or filter combination" })
  async list(@Query() dto: ListIntentsDto) {
    // Issue #440 — reject invalid range combinations with 400.
    if (
      dto.minAmountUsd !== undefined &&
      dto.maxAmountUsd !== undefined &&
      dto.minAmountUsd > dto.maxAmountUsd
    ) {
      throw new BadRequestException("minAmountUsd must not be greater than maxAmountUsd");
    }
    if (
      dto.createdFrom !== undefined &&
      dto.createdTo !== undefined &&
      dto.createdFrom > dto.createdTo
    ) {
      throw new BadRequestException("createdFrom must not be greater than createdTo");
    }

    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const { intents, total } = await this.intentsService.search({
      state: dto.state,
      user: dto.user,
      chain: dto.chain,
      minAmountUsd: dto.minAmountUsd,
      maxAmountUsd: dto.maxAmountUsd,
      createdFrom: dto.createdFrom,
      createdTo: dto.createdTo,
      srcToken: dto.srcToken,
      dstToken: dto.dstToken,
      solver: dto.solver,
      sort: dto.sort,
      limit,
      offset,
    });
    return { intents, total, limit, offset };
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

  @Get(":id/auction")
  @ApiOkResponse({
    description: "Current and accepted Dutch auction prices",
    schema: {
      type: "object",
      properties: {
        intentId: { type: "string" },
        currentDstAmount: { type: "string" },
        acceptedDstAmount: { type: "string" },
        timestamp: { type: "number" },
      },
    },
  })
  @ApiNotFoundResponse({ description: "Intent not found or does not use a Dutch auction" })
  async getAuctionPrice(@Param("id") id: string) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (!intent.auction) throw new NotFoundException("Intent does not use a Dutch auction");
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      intentId: id,
      currentDstAmount: dutchAuctionPrice(intent.auction, timestamp, intent.minDstAmount),
      acceptedDstAmount: intent.acceptedDstAmount,
      timestamp,
    };
  }

  /**
   * Issue #44 — global IP throttle already applied via AppModule guard.
   * Issue #45 — additionally throttle per dto.user: 10 creates / 60 s.
   */
  @Post()
  @UseGuards(AbuseDetectorGuard, UserThrottlerGuard, KillSwitchGuard)
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
    const intentDeadline = dto.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[dto.srcChain] ?? DEFAULT_DEADLINE_SECONDS);
    if (dto.auction) {
      let startAmount: bigint;
      let minimumAmount: bigint;
      try {
        startAmount = BigInt(dto.auction.startDstAmount);
        minimumAmount = BigInt(dto.minDstAmount);
      } catch {
        throw new BadRequestException("Auction amounts must be valid integer strings");
      }
      if (startAmount < minimumAmount || dto.auction.decayEnd <= dto.auction.decayStart) {
        throw new BadRequestException("Auction start amount must be at least minDstAmount and decayEnd must follow decayStart");
      }
      if (dto.auction.decayEnd > intentDeadline) {
        throw new BadRequestException("Auction decayEnd cannot exceed the intent deadline");
      }
      const hasExclusiveSolver = dto.auction.exclusiveSolver !== undefined;
      const hasExclusivityEnd = dto.auction.exclusivityEnd !== undefined;
      if (hasExclusiveSolver !== hasExclusivityEnd) {
        throw new BadRequestException("exclusiveSolver and exclusivityEnd must be provided together");
      }
      if (
        hasExclusivityEnd &&
        (dto.auction.exclusivityEnd! <= now ||
          dto.auction.exclusivityEnd! > dto.auction.decayEnd ||
          dto.auction.exclusivityEnd! - now > 300)
      ) {
        throw new BadRequestException("Auction exclusivity must end within 300 seconds and before decayEnd");
      }
    }
    let evmSignatureProof: IntentSignatureProof | undefined;

    if (dto.srcChain !== "stellar" && !(this.nodeEnv === "test" && !dto.signature)) {
      if (!dto.signature || !dto.nonce || dto.expiresAt === undefined || dto.deadline === undefined) {
        throw new BadRequestException("EVM intent creation requires signature, nonce, expiresAt, and deadline");
      }
      this.assertEvmSignatureExpiry(dto.expiresAt);
      await this.evmSignatures.verifyCreateIntent(dto.srcChain, {
        user: dto.user,
        srcTokenAddress: dto.srcTokenAddress,
        srcTokenSymbol: dto.srcTokenSymbol,
        srcTokenDecimals: dto.srcTokenDecimals,
        srcAmount: dto.srcAmount,
        dstTokenContract: dto.dstTokenContract,
        dstTokenSymbol: dto.dstTokenSymbol,
        dstTokenDecimals: dto.dstTokenDecimals,
        minDstAmount: dto.minDstAmount,
        auction: dto.auction,
        deadline: dto.deadline,
        nonce: dto.nonce,
        expiresAt: dto.expiresAt,
      }, dto.signature);
      evmSignatureProof = { action: "create", signer: dto.user, nonce: dto.nonce, expiresAt: dto.expiresAt };
    }

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

    if (evmSignatureProof) await this.consumeIntentNonce(evmSignatureProof);

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
        auction: dto.auction,
        deadline: intentDeadline,
      },
      dto.idempotencyKey,
    );

    // Attach semantic span attributes and capture traceparent for outbox/job payloads.
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttribute(ATTR.INTENT_ID, intent.intentId);
      activeSpan.setAttribute(ATTR.INTENT_USER, intent.user);
      activeSpan.setAttribute(ATTR.INTENT_CHAIN, intent.srcChain);
      activeSpan.setAttribute(ATTR.INTENT_AMOUNT, intent.srcAmount);
      activeSpan.setAttribute(ATTR.INTENT_STATE, intent.state);
    }
    const traceparent = captureTraceparent();

    this.intentsGateway.broadcast({ type: "intent_created", intent, traceparent });
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
  // Read-only lookup: POST only because the ID list can exceed a query string,
  // so the 201 that Nest infers for @Post would misreport it as a creation.
  @HttpCode(200)
  async batchLookup(@Body() dto: BatchLookupDto) {
    const intents = await this.intentsService.getMany(dto.intentIds);
    return { intents, count: intents.length };
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

    if (intent.state !== "open") {
      throw new ConflictException(`Intent is ${intent.state}, cannot accept`);
    }

    if (
      intent.auction?.exclusiveSolver &&
      intent.auction.exclusivityEnd !== undefined &&
      now < intent.auction.exclusivityEnd &&
      intent.auction.exclusiveSolver.toLowerCase() !== dto.solver.toLowerCase()
    ) {
      throw new ForbiddenException("Intent is exclusive to another solver until the exclusivity window ends");
    }

    // Verify the solver controls the claimed address before it can accept.
    const signatureProof = this.verifyIntentSignature(
      "accept",
      dto.solver,
      dto.signature,
      dto.nonce,
      dto.expiresAt,
      buildAcceptMessage(id, dto.solver),
      (context) => buildAcceptMessage(id, dto.solver, context),
    );

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

    await this.consumeIntentNonce(signatureProof);
    const acceptedDstAmount = intent.auction
      ? dutchAuctionPrice(intent.auction, now, intent.minDstAmount)
      : undefined;
    const updated = await this.intentsService.acceptIfOpen(id, dto.solver, now, acceptedDstAmount);
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
      ...(updated.acceptedDstAmount ? { acceptedDstAmount: updated.acceptedDstAmount } : {}),
    });
    this.intentsGateway.broadcast({
      type: "intent_accepted",
      intentId: id,
      solver: dto.solver,
      ...(updated.acceptedDstAmount ? { acceptedDstAmount: updated.acceptedDstAmount } : {}),
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

    if (intent.state !== "accepted") {
      throw new ConflictException(`Intent is ${intent.state}, cannot fill`);
    }
    if (intent.solver !== dto.solver) {
      throw new ForbiddenException("Wrong solver for this intent");
    }

    // Verify the solver controls the claimed address
    const signatureProof = this.verifyIntentSignature(
      "fill",
      dto.solver,
      dto.signature,
      dto.nonce,
      dto.expiresAt,
      buildFillMessage(id, dto.solver),
      (context) =>
        buildFillMessage(id, dto.solver, context, { fillAmount: dto.fillAmount, txHash: dto.txHash }),
    );

    if (!dto.txHash) throw new BadRequestException("A Stellar transaction hash is required");
    try {
      const reserved = await this.intentsService.reserveFillTxHash(id, dto.solver, dto.txHash);
      if (!reserved) {
        throw new ConflictException("Intent is not available for this fill or already has another transaction hash");
      }
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new ConflictException("Transaction hash is already assigned to another intent");
      }
      throw error;
    }
    const verdict = await this.fillVerifier.verify(dto.txHash, intent);
    if (verdict.status === "pending") {
      await this.intentsService.update(id, {
        fillVerificationState: "pending",
        fillVerificationReason: verdict.reason,
      });
      throw new ServiceUnavailableException({
        message: "Fill transaction is awaiting Horizon verification; retry with the same transaction hash",
        verification: verdict.reason,
      });
    }
    if (verdict.status === "rejected") {
      await this.intentsService.update(id, {
        fillVerificationState: "rejected",
        fillVerificationReason: verdict.reason,
        fillVerifiedAt: new Date().toISOString(),
      });
      await this.solversService.recordFailedFill(dto.solver, id);
      this.intentsService.appendAuditEntry(id, "accepted", dto.solver, "fill verification rejected", {
        txHash: dto.txHash,
        reason: verdict.reason,
      });
      throw new BadRequestException({ message: "Fill transaction verification failed", reason: verdict.reason });
    }

    await this.intentsService.update(id, {
      fillVerificationState: "verified",
      fillVerificationReason: verdict.operation,
      fillVerifiedAt: new Date().toISOString(),
    });

    const fillAmount = BigInt(verdict.deliveredAmount);
    let minAmount: bigint;
    try {
      minAmount = BigInt(intent.acceptedDstAmount ?? intent.minDstAmount);
    } catch {
      throw new BadRequestException({
        error: "Data integrity error: intent minDstAmount is not a valid integer",
        intentId: id,
        minDstAmount: intent.acceptedDstAmount ?? intent.minDstAmount,
      });
    }
    if (fillAmount < minAmount) {
      throw new BadRequestException({
        error: "Fill amount below minimum",
        fillAmount: dto.fillAmount,
        minDstAmount: intent.minDstAmount,
      });
    }

    await this.consumeIntentNonce(signatureProof);
    const feeAmount = (BigInt(dto.fillAmount) * 5n) / 10000n;
    const feeAmount = (fillAmount * 5n) / 10000n;

    const updated = await this.intentsService.fillIfAccepted(id, dto.solver, {
      filledAt: now,
      fillAmount: verdict.deliveredAmount,
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
      fillAmount: verdict.deliveredAmount,
      txHash: dto.txHash,
    });
    this.intentsGateway.broadcast({
      type: "intent_filled",
      intentId: id,
      solver: dto.solver,
      fillAmount: verdict.deliveredAmount,
    });
    return updated;
  }

  @Post(":id/cancel")
  @UseGuards(AbuseDetectorGuard)
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

    let signatureProof: IntentSignatureProof;
    if (intent.srcChain === "stellar") {
      signatureProof = this.verifyIntentSignature(
        "cancel",
        dto.user,
        dto.signature,
        dto.nonce,
        dto.expiresAt,
        buildCancelMessage(id),
        (context) => buildCancelMessage(id, context, dto.user),
      );
    } else {
      if (!dto.nonce || dto.expiresAt === undefined) {
        throw new BadRequestException("EVM cancellation requires nonce and expiresAt");
      }
      this.assertEvmSignatureExpiry(dto.expiresAt);
      await this.evmSignatures.verifyCancelIntent(
        intent.srcChain,
        dto.user,
        id,
        dto.nonce,
        dto.expiresAt,
        dto.signature,
      );
      signatureProof = { action: "cancel", signer: dto.user, nonce: dto.nonce, expiresAt: dto.expiresAt };
    }

    await this.consumeIntentNonce(signatureProof);
    const updated = await this.intentsService.cancelIfOpen(id);
    if (!updated) {
      const current = await this.intentsService.get(id);
      throw new ConflictException(`Cannot cancel intent in state: ${current?.state ?? "unknown"}`);
    }

    // Audit trail (issue #217 / #62): record who cancelled and when.
    this.intentsService.appendAuditEntry(id, "cancelled", dto.user, "user cancelled");

    // Record cancellation for abuse scoring (create/cancel ratio rule).
    void this.abuseScorer.recordCancel(dto.user.toLowerCase());

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
