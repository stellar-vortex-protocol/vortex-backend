import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LOG_EVENTS } from "../common/log-schema";
import { createLogger } from "../common/logger";

/** One privileged operator action, persisted to `admin_audit_log`. */
export interface AdminAuditEntry {
  /** Admin principal id, or "guardian"/"system" for automated actions. */
  actor: string;
  /** Dotted action name, e.g. "flag.update", "guardian.override". */
  action: string;
  /** What was acted on, e.g. "flag:onchain-dry-run". */
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/**
 * Append-only audit trail for admin and governance actions (issues #495, #507).
 *
 * {@link record} throws when the write fails so callers can refuse changes
 * that must not happen unaudited; safety-increasing actions may catch and
 * proceed instead.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = createLogger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists `entry`. Pass a transaction client to commit the audit row
   * atomically with the change it describes.
   */
  async record(entry: AdminAuditEntry, client: Prisma.TransactionClient = this.prisma): Promise<void> {
    // Issue #488: one `admin.action` record per privileged action — the
    // `VortexAdminActionAnomaly` log alert watches the rate of these.
    this.logger.warn("admin action", {
      event: LOG_EVENTS.ADMIN_ACTION,
      action: entry.action,
      target: entry.target,
      actor: entry.actor,
    });
    try {
      await client.adminAuditLog.create({
        data: {
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          before: toJson(entry.before),
          after: toJson(entry.after),
          reason: entry.reason,
        },
      });
    } catch (err) {
      this.logger.error("admin audit write failed", { action: entry.action, target: entry.target, err });
      throw new ServiceUnavailableException("Audit log unavailable; action not applied");
    }
  }

  /** Most recent entries for a target, newest first. */
  async forTarget(target: string, limit = 100) {
    return this.prisma.adminAuditLog.findMany({
      where: { target },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
