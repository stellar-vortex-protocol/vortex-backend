import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { Router } from "express";
import { AppConfig } from "../config/configuration";
import { logger as winstonLogger } from "../common/logger";
import { MetricsService } from "../metrics/metrics.service";
import { BullMqJobQueueDriver } from "./bullmq-job-queue.driver";
import { MemoryJobQueueDriver } from "./memory-job-queue.driver";
import {
  DeadLetter,
  EnqueueOptions,
  JobDefinition,
  JobEvents,
  JobHandler,
  JobQueueDriver,
  JobResult,
  JobSchedule,
  QueueSettings,
  QueueStats,
} from "./jobs.types";

/** Optional injection token to supply a custom {@link JobQueueDriver} (tests). */
export const JOB_QUEUE_DRIVER = Symbol("JOB_QUEUE_DRIVER");

/** Queue name for the daily credential expiry-warning sweep (issue #708). */
export const EXPIRY_WARNING_QUEUE = "credentials";

/** Job name for the daily credential expiry-warning sweep (issue #708). */
export const EXPIRY_WARNING_JOB = "expiry-warning";

/** Default warning window when none is configured: 7 days. */
export const DEFAULT_EXPIRY_WARNING_WINDOW_DAYS = 7;

/** One credential surfaced by the expiry-warning sweep. */
export interface ExpiringCredential {
  kind: "api_key" | "solver_credential";
  id: string;
  /** Non-secret identifier shown to operators (key prefix / credential label). */
  prefix: string;
  /** Owner of an API key, or the solver the credential belongs to. */
  owner: string;
  expiresAt: Date;
}

/** Repository surface the expiry-warning job depends on (issue #708). */
export interface ExpiringCredentialsSource {
  findExpiringBetween(from: Date, to: Date): Promise<ExpiringCredential[]>;
  markExpiryWarned(ids: string[]): Promise<void>;
}

/** Optional injection token for the expiry-warning data source (tests). */
export const EXPIRY_WARNING_SOURCE = Symbol("EXPIRY_WARNING_SOURCE");

/** Payload of the daily expiry-warning job. */
export interface ExpiryWarningJobData {
  /** Warning window in days; resolved from config when omitted. */
  windowDays?: number;
}

/**
 * Background job facade (issue #494).
 *
 * Producers call {@link enqueue} / {@link schedule} from any process role.
 * {@link process} registers a worker only when PROCESS_ROLE is "worker" or
 * "all"; in the "api" role it is a no-op so HTTP pods never execute jobs.
 */
@Injectable()
export class JobsService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly driver: JobQueueDriver;
  private readonly isWorker: boolean;
  private readonly shutdownTimeoutMs: number;
  private readonly expiryWarningWindowDays: number;

  constructor(
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @Inject(JOB_QUEUE_DRIVER) driver?: JobQueueDriver,
    @Optional() @Inject(EXPIRY_WARNING_SOURCE) private readonly expirySource?: ExpiringCredentialsSource,
  ) {
    const jobs = config.get("jobs", { infer: true });
    this.driver =
      driver ??
      (jobs.driver === "bullmq"
        ? new BullMqJobQueueDriver(config.get("redisUrl", { infer: true }))
        : new MemoryJobQueueDriver());
    this.isWorker = config.get("processRole", { infer: true }) !== "api";
    this.shutdownTimeoutMs = jobs.shutdownTimeoutMs;
    this.expiryWarningWindowDays =
      (config as unknown as ConfigService<Record<string, number>>).get("expiryWarningWindowDays") ??
      DEFAULT_EXPIRY_WARNING_WINDOW_DAYS;
    this.metrics?.setQueueDepthProvider(async () =>
      (await this.stats()).flatMap((s) => [
        { queue: s.queue, state: "waiting", count: s.waiting },
        { queue: s.queue, state: "active", count: s.active },
        { queue: s.queue, state: "delayed", count: s.delayed },
        { queue: s.queue, state: "dead_letter", count: s.deadLetter },
      ]),
    );
  }

  /** Declares a queue and its worker settings. Idempotent; call before use. */
  defineQueue(queue: string, settings: QueueSettings): void {
    this.driver.defineQueue(queue, settings);
  }

  /** Enqueues one job; returns the job id (the existing one for a duplicate idempotency key). */
  enqueue<T>(def: JobDefinition<T>, data: T, opts?: EnqueueOptions): Promise<string> {
    return this.driver.enqueue(def, data, opts);
  }

  /**
   * Enqueues a linear chain of jobs: each step starts only after the previous
   * one completes successfully. Returns the first job's id.
   */
  enqueueChain<T>(steps: { def: JobDefinition<T>; data: T }[]): Promise<string> {
    return this.driver.enqueueChain(steps);
  }

  /** Enqueues `def` every `everyMs`. Safe to call from every instance. */
  schedule<T>(def: JobDefinition<T>, everyMsOrOpts: number | { everyMs: number; data: T }, maybeData?: T): Promise<void> {
    if (typeof everyMsOrOpts === "object") {
      return this.driver.schedule(def, everyMsOrOpts.everyMs, everyMsOrOpts.data);
    }
    return this.driver.schedule(def, everyMsOrOpts, maybeData as T);
  }

  /** Registers the handler for `def` — only in worker-capable roles. */
  process<T, R = unknown>(def: JobDefinition<T, R>, handler: JobHandler<T, R>): void {
    if (!this.isWorker) {
      this.logger.debug(`[jobs] PROCESS_ROLE=api — not consuming ${def.queue}/${def.name}`);
      return;
    }
    this.driver.process(def, handler, this.events);
  }

  /**
   * Registers the daily credential expiry-warning sweep (issue #708).
   */
  registerExpiryWarningJob(): void {
    const def: JobDefinition<ExpiryWarningJobData> = {
      queue: EXPIRY_WARNING_QUEUE,
      name: EXPIRY_WARNING_JOB,
      attempts: 3,
      backoffMs: 1_000,
    };
    this.defineQueue(EXPIRY_WARNING_QUEUE, { concurrency: 1 });
    void this.schedule(def, 24 * 60 * 60 * 1000, {});
    this.process(def, async (data) => {
      await this.runExpiryWarningSweep(data);
    });
  }

  /**
   * Runs one expiry-warning sweep. Returns the credentials surfaced so the
   * admin endpoint and tests can reuse the same query path.
   */
  async runExpiryWarningSweep(data: ExpiryWarningJobData = {}): Promise<ExpiringCredential[]> {
    if (!this.expirySource) {
      this.logger.debug("[jobs] expiry-warning: no credential source wired — skipping");
      return [];
    }
    const windowDays = data.windowDays ?? this.expiryWarningWindowDays;
    const now = new Date();
    const until = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

    const expiring = await this.expirySource.findExpiringBetween(now, until);
    for (const credential of expiring) {
      winstonLogger.warn("Credential expiring soon", {
        event: "credential.expiring_soon",
        kind: credential.kind,
        id: credential.id,
        prefix: credential.prefix,
        owner: credential.owner,
        expiresAt: credential.expiresAt.toISOString(),
        windowDays,
      });
    }
    if (expiring.length > 0) {
      await this.expirySource.markExpiryWarned(expiring.map((c) => c.id));
    }
    return expiring;
  }

  async stats(): Promise<QueueStats[]> {
    return Promise.all(this.driver.queues().map((q) => this.driver.stats(q)));
  }

  deadLetters(queue: string, limit?: number): Promise<DeadLetter[]> {
    return this.driver.deadLetters(queue, limit);
  }

  /**
   * Cancels a pending/delayed/scheduled job. Returns whether a job was found
   * and removed; an already-active or completed job yields `false`.
   */
  cancel(queue: string, jobId: string): Promise<boolean> {
    return this.driver.cancel(queue, jobId);
  }

  /**
   * Re-enqueues a dead-lettered job for another attempt (issue #693).
   * Returns false when no dead-letter record matches `jobId`.
   */
  retryDeadLetter(queue: string, jobId: string): Promise<boolean> {
    return this.driver.retryDeadLetter(queue, jobId);
  }

  /** Looks up the status/result of a previously enqueued job (issue #694). */
  getResult(queue: string, jobId: string): Promise<JobResult> {
    return this.driver.getResult(queue, jobId);
  }

  /** Lists the repeating schedules registered on `queue` (issue #695). */
  listSchedules(queue: string): Promise<JobSchedule[]> {
    return this.driver.listSchedules(queue);
  }

  /** Cancels a repeating schedule; false when no such schedule exists (issue #695). */
  unschedule(queue: string, name: string): Promise<boolean> {
    return this.driver.unschedule(queue, name);
  }

  queues(): string[] {
    return this.driver.queues();
  }

  /**
   * Bull Board router for the BullMQ driver, or null for the memory driver
   * (use GET /admin/jobs/queues instead). Mount it behind admin RBAC.
   */
  createBoardRouter(basePath: string): Router | null {
    if (!(this.driver instanceof BullMqJobQueueDriver)) return null;
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath(basePath);
    createBullBoard({
      queues: this.driver.bullQueues().map((q) => new BullMQAdapter(q)),
      serverAdapter,
    });
    return serverAdapter.getRouter();
  }

  /** Finishes or returns in-flight jobs before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await this.driver.close(this.shutdownTimeoutMs);
  }

  private readonly events: JobEvents = {
    onComplete: (def, durationMs) => {
      this.metrics?.jobsDuration.observe(
        { queue: def.queue, job: def.name, outcome: "completed" },
        durationMs / 1000,
      );
    },
    onFailure: (def, durationMs, willRetry) => {
      this.metrics?.jobsDuration.observe(
        { queue: def.queue, job: def.name, outcome: "failed" },
        durationMs / 1000,
      );
      this.metrics?.jobsFailures.inc({ queue: def.queue, job: def.name });
      if (!willRetry) {
        this.metrics?.jobsDeadLettered.inc({ queue: def.queue, job: def.name });
        this.logger.error(`[jobs] ${def.queue}/${def.name} exhausted ${def.attempts} attempts — dead-lettered`);
      }
    },
  };
}
