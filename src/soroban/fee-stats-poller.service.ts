import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SorobanService } from './soroban.service';

export interface FeeSample {
  sampledAt: Date;
  p50: string | null;
  p90: string | null;
  p99: string | null;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HISTORY_HOURS = 24 * 7;
const MAX_SAMPLES = 5000;

/**
 * Periodically samples Soroban inclusion-fee percentiles so operators can
 * inspect historical trends when tuning SOROBAN_FEE_PERCENTILE.
 *
 * Samples are kept in-memory; RPC failures are logged and the previous
 * sample is retained rather than throwing.
 */
@Injectable()
export class FeeStatsPollerService {
  private readonly logger = new Logger(FeeStatsPollerService.name);
  private readonly samples: FeeSample[] = [];

  constructor(private readonly sorobanService: SorobanService) {}

  @Interval(POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    try {
      const stats = await this.sorobanService.getFeeStats();
      const sample: FeeSample = {
        sampledAt: new Date(),
        p50: this.normalize(stats?.sorobanInclusionFee?.p50),
        p90: this.normalize(stats?.sorobanInclusionFee?.p90),
        p99: this.normalize(stats?.sorobanInclusionFee?.p99),
      };
      this.samples.push(sample);
      if (this.samples.length > MAX_SAMPLES) {
        this.samples.splice(0, this.samples.length - MAX_SAMPLES);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to sample Soroban fee stats: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  getHistory(hours = 24): FeeSample[] {
    const boundedHours = Math.min(
      Math.max(1, Math.floor(hours)),
      MAX_HISTORY_HOURS,
    );
    const cutoff = Date.now() - boundedHours * 60 * 60 * 1000;
    return this.samples.filter((sample) => sample.sampledAt.getTime() >= cutoff);
  }

  private normalize(value: string | undefined | null): string | null {
    if (value === undefined || value === null || value === '' || value === '0') {
      return null;
    }
    return value;
  }
}
