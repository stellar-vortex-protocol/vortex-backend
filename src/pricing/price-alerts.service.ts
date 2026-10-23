import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AggregatorService } from './aggregator.service';
import { IntentsGateway } from '../intents/intents.gateway';

export type PriceAlertDirection = 'above' | 'below';

export interface CreatePriceAlertInput {
  tokenAddress: string;
  chain: string;
  direction: PriceAlertDirection;
  thresholdUsd: number;
  /** Optional WS connection id to notify; defaults to the caller's socket. */
  connectionId?: string;
}

interface PriceAlertRecord {
  id: string;
  tokenAddress: string;
  chain: string;
  direction: string;
  thresholdUsd: number;
  connectionId: string | null;
  active: boolean;
  lastPriceUsd: number | null;
  createdAt: Date;
  triggeredAt: Date | null;
}

const CHECK_INTERVAL_MS = 15_000;

@Injectable()
export class PriceAlertsService {
  private readonly logger = new Logger(PriceAlertsService.name);
  private checking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregator: AggregatorService,
    private readonly gateway: IntentsGateway,
  ) {}

  async create(input: CreatePriceAlertInput): Promise<PriceAlertRecord> {
    const { tokenAddress, chain, direction, thresholdUsd } = input;

    if (direction !== 'above' && direction !== 'below') {
      throw new BadRequestException(
        'direction must be either "above" or "below"',
      );
    }
    if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
      throw new BadRequestException('thresholdUsd must be a positive number');
    }

    // Reject at creation time if the registry has no price for this pair.
    const snapshot = await this.aggregator.getPriceSnapshot(tokenAddress, chain);
    if (!snapshot || !Number.isFinite(snapshot.priceUsd)) {
      throw new BadRequestException(
        `No oracle price available for ${tokenAddress} on ${chain}`,
      );
    }

    return this.prisma.priceAlert.create({
      data: {
        tokenAddress,
        chain,
        direction,
        thresholdUsd,
        connectionId: input.connectionId ?? null,
        active: true,
        lastPriceUsd: snapshot.priceUsd,
      },
    }) as unknown as Promise<PriceAlertRecord>;
  }

  async cancel(id: string): Promise<{ id: string; cancelled: boolean }> {
    const existing = (await this.prisma.priceAlert.findUnique({
      where: { id },
    })) as PriceAlertRecord | null;
    if (!existing) {
      throw new NotFoundException(`Price alert ${id} not found`);
    }
    await this.prisma.priceAlert.update({
      where: { id },
      data: { active: false },
    });
    return { id, cancelled: true };
  }

  @Interval(CHECK_INTERVAL_MS)
  async checkAlerts(): Promise<void> {
    if (this.checking) {
      return;
    }
    this.checking = true;
    try {
      const alerts = (await this.prisma.priceAlert.findMany({
        where: { active: true },
      })) as PriceAlertRecord[];
      if (alerts.length === 0) {
        return;
      }

      // Poll each distinct token/chain pair exactly once per tick.
      const prices = new Map<string, number | null>();
      for (const alert of alerts) {
        const key = `${alert.chain}:${alert.tokenAddress}`;
        if (prices.has(key)) {
          continue;
        }
        try {
          const snapshot = await this.aggregator.getPriceSnapshot(
            alert.tokenAddress,
            alert.chain,
          );
          prices.set(
            key,
            snapshot && Number.isFinite(snapshot.priceUsd)
              ? snapshot.priceUsd
              : null,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to fetch price for ${key}: ${(err as Error).message}`,
          );
          prices.set(key, null);
        }
      }

      for (const alert of alerts) {
        const price = prices.get(`${alert.chain}:${alert.tokenAddress}`);
        if (price === null || price === undefined) {
          continue;
        }
        if (!this.isCrossed(alert, price)) {
          continue;
        }
        await this.fire(alert, price);
      }
    } finally {
      this.checking = false;
    }
  }

  private isCrossed(alert: PriceAlertRecord, price: number): boolean {
    if (alert.direction === 'above') {
      return price >= alert.thresholdUsd;
    }
    return price <= alert.thresholdUsd;
  }

  private async fire(alert: PriceAlertRecord, price: number): Promise<void> {
    // Deactivate first so a concurrent tick cannot double-fire this alert.
    const updated = await this.prisma.priceAlert.updateMany({
      where: { id: alert.id, active: true },
      data: { active: false, triggeredAt: new Date(), lastPriceUsd: price },
    });
    if (updated.count === 0) {
      return;
    }

    const payload = {
      alertId: alert.id,
      tokenAddress: alert.tokenAddress,
      chain: alert.chain,
      direction: alert.direction,
      thresholdUsd: alert.thresholdUsd,
      priceUsd: price,
      triggeredAt: new Date().toISOString(),
    };

    try {
      this.gateway.emitPriceAlert(payload, alert.connectionId ?? undefined);
    } catch (err) {
      this.logger.warn(
        `Failed to emit price alert ${alert.id}: ${(err as Error).message}`,
      );
    }
  }
}
