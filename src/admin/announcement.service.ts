import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';
import { IntentsGateway } from '../intents/intents.gateway';

export type AnnouncementSeverity = 'info' | 'warning' | 'critical';

export interface AnnouncementRecord {
  id: string;
  message: string;
  severity: AnnouncementSeverity;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicAnnouncement {
  message: string;
  severity: AnnouncementSeverity;
  expiresAt: string | null;
  updatedAt: string;
}

export interface SetAnnouncementInput {
  message: string;
  severity: AnnouncementSeverity;
  expiresAt?: Date | string | null;
  actor: string;
}

export interface ClearAnnouncementInput {
  actor: string;
}

const SINGLETON_ID = 'singleton';
const EXPIRY_TICK_INTERVAL_MS = 30_000;

/**
 * Operator-authored service status banner.
 *
 * Persists a single-row announcement so it survives restarts and is consistent
 * across replicas. Broadcasts a `status_announcement` WS event through
 * `IntentsGateway.broadcast()` only on real state changes (set, clear, or an
 * expiry transition) — never on routine reads/polls.
 */
@Injectable()
export class AnnouncementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnnouncementService.name);
  private expiryTimer: NodeJS.Timeout | null = null;
  private lastBroadcastExpired = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly gateway: IntentsGateway,
  ) {}

  onModuleInit(): void {
    this.expiryTimer = setInterval(() => {
      this.checkExpiryTransition().catch((err) => {
        this.logger.error(
          `Announcement expiry tick failed: ${(err as Error).message}`,
        );
      });
    }, EXPIRY_TICK_INTERVAL_MS);
    // Do not keep the process alive solely for this timer.
    if (typeof this.expiryTimer.unref === 'function') {
      this.expiryTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * Set (or replace) the active announcement. Persists, audits, and broadcasts
   * a `status_announcement` event.
   */
  async set(input: SetAnnouncementInput): Promise<PublicAnnouncement> {
    const expiresAt = this.normalizeExpiresAt(input.expiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException(
        'expiresAt must be in the future when setting an announcement',
      );
    }

    const record = await this.prisma.announcement.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        message: input.message,
        severity: input.severity,
        expiresAt,
      },
      update: {
        message: input.message,
        severity: input.severity,
        expiresAt,
      },
    });

    await this.audit.record({
      actor: input.actor,
      action: 'announcement.set',
      target: SINGLETON_ID,
      metadata: {
        message: input.message,
        severity: input.severity,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    });

    this.lastBroadcastExpired = false;
    this.broadcast('set', record);

    return this.toPublic(record);
  }

  /**
   * Clear the active announcement. Persists, audits, and broadcasts a
   * `status_announcement` event.
   */
  async clear(input: ClearAnnouncementInput): Promise<void> {
    const existing = await this.prisma.announcement.findUnique({
      where: { id: SINGLETON_ID },
    });

    await this.prisma.announcement.deleteMany({
      where: { id: SINGLETON_ID },
    });

    await this.audit.record({
      actor: input.actor,
      action: 'announcement.clear',
      target: SINGLETON_ID,
      metadata: existing
        ? {
            previousMessage: existing.message,
            previousSeverity: existing.severity,
            previousExpiresAt: existing.expiresAt
              ? existing.expiresAt.toISOString()
              : null,
          }
        : {},
    });

    this.lastBroadcastExpired = false;
    this.broadcast('clear', null);
  }

  /**
   * Returns the currently-active announcement, or null. An announcement whose
   * `expiresAt` has passed is treated as cleared at read time.
   */
  async getPublic(): Promise<PublicAnnouncement | null> {
    const record = await this.prisma.announcement.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!record) {
      return null;
    }
    if (this.isExpired(record)) {
      return null;
    }
    return this.toPublic(record);
  }

  /**
   * Periodic tick: detect an expiry transition (active -> expired) and
   * broadcast a single `status_announcement` clear event. Does not re-broadcast
   * an already-expired announcement on subsequent ticks.
   */
  async checkExpiryTransition(): Promise<void> {
    const record = await this.prisma.announcement.findUnique({
      where: { id: SINGLETON_ID },
    });

    if (!record) {
      this.lastBroadcastExpired = false;
      return;
    }

    if (this.isExpired(record)) {
      if (!this.lastBroadcastExpired) {
        this.lastBroadcastExpired = true;
        this.broadcast('expired', null);
      }
      return;
    }

    this.lastBroadcastExpired = false;
  }

  private isExpired(record: AnnouncementRecord): boolean {
    return !!record.expiresAt && record.expiresAt.getTime() <= Date.now();
  }

  private normalizeExpiresAt(
    value: Date | string | null | undefined,
  ): Date | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new NotFoundException('expiresAt must be a valid ISO date');
    }
    return date;
  }

  private toPublic(record: AnnouncementRecord): PublicAnnouncement {
    return {
      message: record.message,
      severity: record.severity,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Broadcast a `status_announcement` event, mirroring the `protocol_status`
   * event shape conventions used by the kill switch.
   */
  private broadcast(
    reason: 'set' | 'clear' | 'expired',
    record: AnnouncementRecord | null,
  ): void {
    try {
      this.gateway.broadcast('status_announcement', {
        type: 'status_announcement',
        reason,
        announcement: record ? this.toPublic(record) : null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to broadcast status_announcement: ${(err as Error).message}`,
      );
    }
  }
}