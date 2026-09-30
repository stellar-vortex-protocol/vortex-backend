import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { Router } from "express";
import { AppConfig } from "../config/configuration";
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
  QueueSettings,
  QueueStats,
} from "./jobs.types";

/** Optional injection token to supply a custom {@link JobQueueDriver} (tests). */
export const JOB_QUEUE_DRIVER = Symbol("JOB_QUEUE_DRIVER");

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

  constructor(
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @Inject(JOB_QUEUE_DRIVER) driver?: JobQueueDriver,
  ) {
    const jobs = config.get("jobs", { infer: true });
    this.driver =
      driver ??
      (jobs.driver === "bullmq"
        ? new BullMqJobQueueDriver(config.get("redisUrl", { infer: true }))
        : new MemoryJobQueueDriver());
    this.isWorker = config.get("processRole", { infer: true }) !== "api";
    this.shutdownTimeoutMs = jobs.shutdownTimeoutMs;
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

  /** Enqueues `def` every `everyMs`. Safe to call from every instance. */
  schedule<T>(def: JobDefinition<T>, everyMs: number, data: T): Promise<void> {
    return this.driver.schedule(def, everyMs, data);
  }

  /** Registers the handler for `def` — only in worker-capable roles. */
  process<T>(def: JobDefinition<T>, handler: JobHandler<T>): void {
    if (!this.isWorker) {
      this.logger.debug(`[jobs] PROCESS_ROLE=api — not consuming ${def.queue}/${def.name}`);
      return;
    }
    this.driver.process(def, handler, this.events);
  }

  async stats(): Promise<QueueStats[]> {
    return Promise.all(this.driver.queues().map((q) => this.driver.stats(q)));
  }

  deadLetters(queue: string, limit?: number): Promise<DeadLetter[]> {
    return this.driver.deadLetters(queue, limit);
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
