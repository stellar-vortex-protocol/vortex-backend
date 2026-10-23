import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { TieredThrottleGuard } from '../auth/rate-limit/tiered-throttle.guard';
import { KillSwitchRepository } from './killswitch.repository';

/**
 * Public-facing description allow-list keyed by `reasonCode`.
 *
 * The operator `reason` field is free text written for other operators and may
 * contain internal notes, identities, or other operator-sensitive detail. We
 * never echo it verbatim on the public endpoint; instead we map the stable
 * `reasonCode` to a curated, public-safe description.
 */
export const PUBLIC_REASON_DESCRIPTIONS: Readonly<Record<string, string>> = {
  MAINTENANCE: 'Scheduled maintenance',
  INCIDENT: 'Operational incident',
  SECURITY: 'Security precaution',
  UPGRADE: 'Protocol upgrade',
  ORACLE_STALE: 'Stale oracle data',
  LIQUIDITY: 'Liquidity conditions',
  MANUAL: 'Manual operator action',
  EMERGENCY: 'Emergency pause',
  DEPENDENCY: 'Upstream dependency issue',
  COMPLIANCE: 'Compliance review',
};

const FALLBACK_REASON = 'Protocol pause';

/**
 * Map a `reasonCode` to a public-facing description.
 *
 * Returns the curated description for known codes, or a generic fallback for
 * unknown codes so we never leak raw operator text.
 */
export function sanitizeReason(reasonCode: string | null | undefined): string {
  if (!reasonCode) {
    return FALLBACK_REASON;
  }
  const key = String(reasonCode).trim().toUpperCase();
  return PUBLIC_REASON_DESCRIPTIONS[key] ?? FALLBACK_REASON;
}

export interface StatusHistoryEntry {
  scope: string;
  chain: string | null;
  token: string | null;
  operation: string | null;
  reasonCode: string | null;
  reason: string;
  startedAt: string;
  resumedAt: string;
}

export interface StatusHistoryResponse {
  entries: StatusHistoryEntry[];
}

@ApiTags('status')
@Controller('api/v1/status')
@UseGuards(TieredThrottleGuard)
export class KillSwitchStatusController {
  constructor(private readonly killSwitchRepository: KillSwitchRepository) {}

  @Get('history')
  @ApiOperation({
    summary: 'List past (resolved) kill-switch pauses',
    description:
      'Public, read-only history of resolved kill-switch pauses, ordered newest-first. ' +
      'Currently-active pauses are intentionally excluded and only surface via /health. ' +
      'No authentication required; rate-limited like other public read endpoints.',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description: 'ISO-8601 timestamp; only return pauses that started at or after this time.',
    type: String,
  })
  @ApiQuery({
    name: 'chain',
    required: false,
    description: 'Filter by chain identifier.',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Resolved pauses, newest-first.',
    schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scope: { type: 'string' },
              chain: { type: 'string', nullable: true },
              token: { type: 'string', nullable: true },
              operation: { type: 'string', nullable: true },
              reasonCode: { type: 'string', nullable: true },
              reason: { type: 'string' },
              startedAt: { type: 'string', format: 'date-time' },
              resumedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid query parameters.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async getHistory(
    @Query('since') since?: string,
    @Query('chain') chain?: string,
  ): Promise<StatusHistoryResponse> {
    let sinceDate: Date | undefined;
    if (since !== undefined && since !== null && since !== '') {
      const parsed = new Date(since);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid `since` timestamp');
      }
      sinceDate = parsed;
    }

    const rows = await this.killSwitchRepository.listResolved(
      sinceDate,
      chain && chain.length > 0 ? chain : undefined,
    );

    const entries: StatusHistoryEntry[] = rows.map((row) => ({
      scope: row.scope,
      chain: row.chain ?? null,
      token: row.token ?? null,
      operation: row.operation ?? null,
      reasonCode: row.reasonCode ?? null,
      reason: sanitizeReason(row.reasonCode),
      startedAt: new Date(row.startedAt).toISOString(),
      resumedAt: new Date(row.resumedAt).toISOString(),
    }));

    return { entries };
  }
}