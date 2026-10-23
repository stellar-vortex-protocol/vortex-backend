import { Controller, Get, Optional, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import {
  HttpEgressService,
  EgressBreakerSnapshot,
} from '../common/http-egress';

/**
 * Response shape for a single tracked circuit breaker.
 */
export interface EgressHealthEntry {
  purpose: string;
  hostname: string;
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastTransitionAt: string | null;
  lastFailureAt: string | null;
}

/**
 * Response shape for the egress health endpoint.
 */
export interface EgressHealthResponse {
  generatedAt: string;
  breakers: EgressHealthEntry[];
}

/**
 * Admin-only endpoint exposing the current state of every per-destination
 * circuit breaker tracked by {@link HttpEgressService}.
 *
 * Breaker state is kept in memory per-process, so this endpoint reflects the
 * state of the replica that serves the request. Cross-replica breaker-state
 * sharing is out of scope (see follow-up noted in the PR).
 */
@Controller('api/v1/admin/egress')
@UseGuards(AdminGuard)
export class EgressHealthController {
  constructor(@Optional() private readonly httpEgressService?: HttpEgressService) {}

  @Get('health')
  getHealth(): EgressHealthResponse {
    const snapshots: EgressBreakerSnapshot[] =
      this.httpEgressService?.getBreakerSnapshots() ?? [];

    return {
      generatedAt: new Date().toISOString(),
      breakers: snapshots.map((snapshot) => ({
        purpose: snapshot.purpose,
        hostname: snapshot.hostname,
        state: snapshot.state,
        failureCount: snapshot.failureCount,
        successCount: snapshot.successCount,
        lastTransitionAt: snapshot.lastTransitionAt
          ? new Date(snapshot.lastTransitionAt).toISOString()
          : null,
        lastFailureAt: snapshot.lastFailureAt
          ? new Date(snapshot.lastFailureAt).toISOString()
          : null,
      })),
    };
  }
}
