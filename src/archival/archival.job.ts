import {
  BadRequestException,
  Body,
  Controller,
  Injectable,
  Logger,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { ArchivalService } from "./archival.service";
import { AppConfig } from "../config/configuration";
import { JobsService } from "../jobs/jobs.service";
import { AdminGuard, RequireAdminRole } from "../admin/admin.guard";
import { defineJob } from "../jobs/jobs.types";

/**
 * Job definition for an admin-triggered archival restore (#696).
 *
 * Runs as a tracked, retryable background job so a restore never blocks an
 * HTTP request and is auditable via the job queue.
 */
export const restoreArchiveJob = defineJob<RestoreArchivePayload, RestoreArchiveResult>(
  "archival",
  "restoreArchive",
  {
    attempts: 3,
    backoffMs: 30_000,
  },
);

export interface RestoreArchivePayload {
  date: string;
  schema: string;
  dryRun: boolean;
}

export interface RestoreArchiveResult {
  date: string;
  schema: string;
  dryRun: boolean;
  intentRowsRestored: number;
  durationMs: number;
}

/**
 * Daily archival job (#413).
 *
 * Runs at 02:00 UTC every day.  Exports all eligible terminal intents from
 * the previous day's partition (and any earlier unarchived partitions back to
 * `retentionDays` ago) to Parquet files in S3, then deletes them from Postgres.
 *
 * The job is a no-op when `ARCHIVAL_ENABLED=false` (the default) so it is
 * safe to deploy before operators opt in.
 *
 * Leader election: when `LEADER_ELECTION_ENABLED=true` the job only fires on
 * the elected leader so a multi-replica deployment does not run parallel
 * archival exports.  The idempotency check inside ArchivalService (manifest
 * already exists → skip) provides a safety net even without leader election.
 */
@Injectable()
export class ArchivalJob {
  private readonly logger = new Logger(ArchivalJob.name);
  private running = false;

  constructor(
    private readonly archivalService: ArchivalService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly jobsService: JobsService,
  ) {}

  /**
   * Register the `restoreArchive` job handler.  Called from the module's
   * `onModuleInit` so the queue is wired before any request can enqueue.
   */
  registerRestoreHandler(): void {
    this.jobsService.process<RestoreArchivePayload, RestoreArchiveResult>(
      restoreArchiveJob,
      async (payload) => {
        this.logger.log(
          `[archival] restore ${payload.date} -> schema ${payload.schema}` +
          (payload.dryRun ? " (dry run)" : ""),
        );
        return this.archivalService.restoreDate(payload.date, {
          schema: payload.schema,
          dryRun: payload.dryRun,
        });
      },
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: "archival-daily", timeZone: "UTC" })
  async runDaily(): Promise<void> {
    const config = this.configService.get("archival", { infer: true });
    if (!config.enabled) {
      this.logger.debug("[archival] job disabled (ARCHIVAL_ENABLED=false)");
      return;
    }

    if (this.running) {
      this.logger.warn("[archival] previous run still in progress — skipping");
      return;
    }

    this.running = true;
    try {
      await this.runBackfillWindow(config.retentionDays);
    } finally {
      this.running = false;
    }
  }

  /**
   * Manually trigger an archival run for a specific date (used by restore
   * tooling and admin endpoints).
   */
  async runForDate(date: string): Promise<void> {
    const result = await this.archivalService.archiveDate(date);
    if (result.skipped) {
      this.logger.log(`[archival] ${date}: already archived (skipped)`);
    } else {
      this.logger.log(
        `[archival] ${date}: archived ${result.intentRowsArchived} intents, ` +
        `deleted ${result.intentRowsDeleted} rows, took ${result.durationMs}ms`,
      );
    }
  }

  /**
   * Enqueue a restore for `date` and return the job id so the caller can poll
   * `GET /admin/jobs/queues/:queue/jobs/:jobId`.
   */
  async enqueueRestore(payload: RestoreArchivePayload): Promise<string> {
    const jobId = await this.jobsService.enqueue(restoreArchiveJob, payload);
    return typeof jobId === "string" ? jobId : (jobId as { id: string }).id;
  }

  /**
   * Archive all dates from `retentionDays` ago up to yesterday (inclusive).
   * This catches up any dates missed due to downtime.
   */
  private async runBackfillWindow(retentionDays: number): Promise<void> {
    const today = new Date();
    const dates: string[] = [];

    for (let i = retentionDays; i >= 1; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    this.logger.log(`[archival] checking ${dates.length} date partitions`);

    for (const date of dates) {
      try {
        await this.archivalService.archiveDate(date);
      } catch (err) {
        // Log and continue — a single date failure must not block the rest.
        this.logger.error(
          `[archival] date ${date} failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

interface RestoreRequestBody {
  date?: unknown;
  schema?: unknown;
  dryRun?: unknown;
}

/**
 * Admin-triggered archival restore endpoint (#696).
 *
 * `POST /admin/archival/restore` enqueues a `restoreArchive` job and returns
 * `{ jobId }`; poll `GET /admin/jobs/queues/archival/jobs/:jobId` for status.
 */
@Controller("admin/archival")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class ArchivalAdminController {
  private readonly logger = new Logger(ArchivalAdminController.name);

  constructor(private readonly archivalJob: ArchivalJob) {}

  @Post("restore")
  async restore(@Body() body: RestoreRequestBody): Promise<{ jobId: string }> {
    const date = body?.date;
    if (typeof date !== "string" || !DATE_RE.test(date)) {
      throw new BadRequestException("date must be a YYYY-MM-DD string");
    }
    // Reject impossible calendar dates (e.g. 2024-02-31).
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException("date is not a valid calendar date");
    }

    const schema = body?.schema ?? "archive_restore";
    if (typeof schema !== "string" || !SCHEMA_RE.test(schema)) {
      throw new BadRequestException(
        "schema must match ^[a-z_][a-z0-9_]*$",
      );
    }

    const dryRun = body?.dryRun ?? false;
    if (typeof dryRun !== "boolean") {
      throw new BadRequestException("dryRun must be a boolean");
    }

    const jobId = await this.archivalJob.enqueueRestore({ date, schema, dryRun });
    this.logger.log(
      `[archival] restore enqueued for ${date} (schema=${schema}, dryRun=${dryRun}) jobId=${jobId}`,
    );
    return { jobId };
  }
}
