import { Controller, Get, Param, Query, BadRequestException, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiParam,
  ApiQuery,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { StrKey } from "@stellar/stellar-sdk";
import { SorobanService } from "./soroban.service";
import { FeeStatsPollerService } from "./fee-stats-poller.service";
import { AccountRateLimitGuard } from "./account-rate-limit.guard";

const MAX_FEE_STATS_HISTORY_HOURS = 168;

@ApiTags("chain")
@Controller({ path: "chain", version: "1" })
export class SorobanController {
  constructor(
    private readonly sorobanService: SorobanService,
    private readonly feeStatsPollerService: FeeStatsPollerService,
  ) {}

  @Get("health")
  @ApiOkResponse({
    description: "Soroban RPC node health status (pass-through of the RPC `getHealth` result).",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", example: "healthy" },
        latestLedger: { type: "number" },
        oldestLedger: { type: "number" },
        ledgerRetentionWindow: { type: "number" },
      },
      required: ["status"],
    },
  })
  getHealth() {
    return this.sorobanService.getHealth();
  }

  @Get("ledger")
  @ApiOkResponse({
    description: "Latest closed ledger as reported by the Soroban RPC node.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        sequence: { type: "number", example: 12345678 },
        protocolVersion: { type: "number" },
      },
      required: ["id", "sequence"],
    },
  })
  getLatestLedger() {
    return this.sorobanService.getLatestLedger();
  }

  @Get("network")
  @ApiOkResponse({
    description: "Network passphrase and protocol metadata for the configured RPC node.",
    schema: {
      type: "object",
      properties: {
        friendbotUrl: { type: "string", nullable: true },
        passphrase: { type: "string", example: "Test SDF Network ; September 2015" },
        protocolVersion: { type: "number" },
      },
      required: ["passphrase"],
    },
  })
  getNetwork() {
    return this.sorobanService.getNetwork();
  }

  @Get("fee-stats")
  @ApiOkResponse({
    description:
      "Live Soroban inclusion-fee statistics (pass-through of the RPC `getFeeStats` result).",
    schema: {
      type: "object",
      properties: {
        sorobanInclusionFee: {
          type: "object",
          properties: {
            max: { type: "string" },
            min: { type: "string" },
            mode: { type: "string" },
            p10: { type: "string" },
            p20: { type: "string" },
            p30: { type: "string" },
            p40: { type: "string" },
            p50: { type: "string" },
            p60: { type: "string" },
            p70: { type: "string" },
            p80: { type: "string" },
            p90: { type: "string" },
            p95: { type: "string" },
            p99: { type: "string" },
          },
        },
        inclusionFee: {
          type: "object",
          properties: {
            max: { type: "string" },
            min: { type: "string" },
            mode: { type: "string" },
            p10: { type: "string" },
            p20: { type: "string" },
            p30: { type: "string" },
            p40: { type: "string" },
            p50: { type: "string" },
            p60: { type: "string" },
            p70: { type: "string" },
            p80: { type: "string" },
            p90: { type: "string" },
            p95: { type: "string" },
            p99: { type: "string" },
          },
        },
        latestLedger: { type: "number" },
      },
    },
  })
  getFeeStats() {
    return this.sorobanService.getFeeStats();
  }

  @Get("fee-stats/history")
  @ApiQuery({
    name: "hours",
    required: false,
    description: `Lookback window in hours (default 24, max ${MAX_FEE_STATS_HISTORY_HOURS}).`,
    example: 24,
  })
  @ApiOkResponse({
    description: "Historical Soroban inclusion-fee percentile samples.",
    schema: {
      type: "object",
      properties: {
        hours: { type: "number", example: 24 },
        samples: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sampledAt: { type: "string", format: "date-time" },
              p50: { type: "string", nullable: true },
              p90: { type: "string", nullable: true },
              p99: { type: "string", nullable: true },
            },
          },
        },
      },
      required: ["hours", "samples"],
    },
  })
  @ApiBadRequestResponse({ description: "Invalid `hours` query parameter" })
  async getFeeStatsHistory(@Query("hours") hours?: string) {
    const parsed = hours === undefined ? 24 : Number(hours);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException("Invalid `hours` query parameter");
    }
    const boundedHours = Math.min(Math.floor(parsed), MAX_FEE_STATS_HISTORY_HOURS);
    const samples = await this.feeStatsPollerService.getHistory(boundedHours);
    return { hours: boundedHours, samples };
  }

  @Get("account/:publicKey")
  @UseGuards(AccountRateLimitGuard)
  @ApiParam({
    name: "publicKey",
    description: "Stellar Ed25519 account public key (starts with `G`, 56 characters).",
    example: "GABC1234567890TESTPUBLICKEY000000000000000000000000000000",
  })
  @ApiOkResponse({
    description: "On-chain account record (id, sequence number, and balances).",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        sequence: { type: "string", example: "987654321" },
        balances: {
          type: "array",
          items: {
            type: "object",
            properties: {
              balance: { type: "string" },
              asset_type: { type: "string" },
            },
          },
        },
      },
      required: ["id", "sequence"],
    },
  })
  @ApiBadRequestResponse({ description: "Invalid Stellar public key format" })
  @ApiTooManyRequestsResponse({
    description: "Per-account rate limit exceeded (AccountRateLimitGuard)",
  })
  getAccount(@Param("publicKey") publicKey: string) {
    if (
      !publicKey ||
      typeof publicKey !== "string" ||
      !(StrKey?.isValidEd25519PublicKey ? StrKey.isValidEd25519PublicKey(publicKey) : /^G[A-Z2-7]{55}$/.test(publicKey))
    ) {
      throw new BadRequestException("Invalid Stellar public key format");
    }
    return this.sorobanService.getAccount(publicKey);
  }
}
