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
} from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";

@Controller("api/v1/intents")
export class IntentsController {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  @Get()
  list(
    @Query("state") state?: string,
    @Query("user") user?: string,
    @Query("chain") chain?: string,
    @Query("limit") limitRaw = "20",
    @Query("offset") offsetRaw = "0",
  ) {
    let intents = this.intentsService.getAll();

    if (state) intents = intents.filter((i) => i.state === state);
    if (user) intents = intents.filter((i) => i.user.toLowerCase() === user.toLowerCase());
    if (chain) intents = intents.filter((i) => i.srcChain === chain);

    const limit = Math.min(parseInt(limitRaw, 10), 100);
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
  getOne(@Param("id") id: string) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    return intent;
  }

  @Post()
  create(@Body() dto: CreateIntentDto) {
    const now = Math.floor(Date.now() / 1000);
    const intent = this.intentsService.create({
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
    });
    this.intentsGateway.broadcast({ type: "intent_created", intent });
    return intent;
  }

  @Post(":id/accept")
  accept(@Param("id") id: string, @Body() dto: AcceptIntentDto) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.state !== "open") {
      throw new ConflictException(`Intent is ${intent.state}, cannot accept`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      this.intentsService.update(id, { state: "expired" });
      throw new GoneException("Intent has expired");
    }

    const solver = this.solversService.get(dto.solver);
    if (!solver?.isActive) {
      throw new ForbiddenException("Solver not registered or inactive");
    }

    const updated = this.intentsService.update(id, {
      state: "accepted",
      solver: dto.solver,
      deadline: now + 300, // 5-minute fill window
    });
    this.intentsGateway.broadcast({ type: "intent_accepted", intentId: id, solver: dto.solver });
    return updated;
  }

  @Post(":id/fill")
  fill(@Param("id") id: string, @Body() dto: FillIntentDto) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.state !== "accepted") {
      throw new ConflictException(`Intent is ${intent.state}, cannot fill`);
    }
    if (intent.solver !== dto.solver) {
      throw new ForbiddenException("Wrong solver for this intent");
    }

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      throw new GoneException("Fill window has expired");
    }

    const fillAmount = BigInt(dto.fillAmount);
    const minAmount = BigInt(intent.minDstAmount);
    if (fillAmount < minAmount) {
      throw new BadRequestException({
        error: "Fill amount below minimum",
        fillAmount: dto.fillAmount,
        minDstAmount: intent.minDstAmount,
      });
    }

    const updated = this.intentsService.update(id, {
      state: "filled",
      filledAt: now,
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
  cancel(@Param("id") id: string, @Body() dto: CancelIntentDto) {
    const intent = this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.user !== dto.user) throw new ForbiddenException("Unauthorized");
    if (intent.state !== "open") {
      throw new ConflictException(`Cannot cancel intent in state: ${intent.state}`);
    }

    const updated = this.intentsService.update(id, { state: "cancelled" });
    this.intentsGateway.broadcast({ type: "intent_cancelled", intentId: id });
    return updated;
  }

  @Post("quote")
  quote(@Body() dto: QuoteRequestDto) {
    const solvers = this.solversService.getAll().filter((s) => s.isActive);
    const quotes = solvers
      .map((solver) => {
        const variance = 1 - Math.random() * 0.008; // 0-0.8% variance
        const dstAmount = Math.floor(Number(dto.srcAmount) * variance);
        const fee = Math.floor(dstAmount * 0.0005); // 0.05%
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
