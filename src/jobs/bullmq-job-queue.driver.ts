import { Logger } from "@nestjs/common";
import { Job, Queue, Worker } from "bullmq";
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

/** Completed jobs (and so their idempotency keys) are retained this long. */
const COMPLETED_RETENTION_SECONDS = 86_400;
const DLQ_SUFFIX = "-dlq";

/**
 * Durable driver on BullMQ + Redis (see docs/adr/0002-job-queue.md).
 *
 * - Retries: BullMQ `attempts` + exponential `backoff`.
 * - DLQ: once the last attempt fails the job is copied to `<queue>-dlq`,
 *   which Bull Board shows next to the source queue.
 * - Idempotency: the key becomes the BullMQ job id (deduplicated by Redis).
 * - Shutdown: `worker.close()` waits for active jobs; on timeout it force-
 *   closes and BullMQ's stalled-job check returns them to another worker.
 */
export class BullMqJobQueueDriver implements JobQueueDriver {
  private readonly logger = new Logger(BullMqJobQueueDriver.name);
  private readonly queueMap = new Map<string, { queue: Queue; dlq: Queue; settings: QueueSettings }>();
  private readonly workers = new Map<string, Worker>();
  private readonly handlers = new Map<string, Map<string, { handler: JobHandler<unknown>; events: JobEvents; def: JobDefinition }>>();
  private readonly redisUrl: string;
  /** Test-only direct queue override used by unit specs. */
  public queue?: { add?: Queue["add"]; getJob?: Queue["getJob"] };

  constructor(redisUrlOrConfig: string | { get: (key: string) => string }) {
    this.redisUrl =
      typeof redisUrlOrConfig === "string"
        ? redisUrlOrConfig
        : redisUrlOrConfig?.get?.("redisUrl") ?? "redis://localhost:6379";
  }

  defineQueue(name: string, settings: QueueSettings): void {
    if (this.queueMap.has(name)) return;
    const connection = { url: this.redisUrl };
    this.queueMap.set(name, {
      queue: new Queue(name, { connection }),
      dlq: new Queue(`${name}${DLQ_SUFFIX}`, { connection }),
      settings,
    });
  }

  async enqueue<T>(
    defOrQueue: JobDefinition<T> | string,
    dataOrName: T | string,
    optsOrData?: EnqueueOptions | T,
    maybeOpts?: EnqueueOptions,
  ): Promise<string> {
    if (typeof defOrQueue === "string") {
      const name = String(dataOrName);
      const data = optsOrData as T;
      const opts = maybeOpts ?? {};
      const targetQueue = this.queue?.add ? (this.queue as Queue) : this.entry(defOrQueue).queue;
      const job = await targetQueue.add(name, data, {
        jobId: opts.idempotencyKey,
        delay: opts.delayMs,
        priority: opts.priority,
      });
      return job.id as string;
    }
    const def = defOrQueue;
    const data = dataOrName as T;
    const opts = (optsOrData as EnqueueOptions | undefined) ?? {};
    const targetQueue = this.queue?.add ? (this.queue as Queue) : this.entry(def.queue).queue;
    const job = await targetQueue.add(def.name, data, {
      ...this.jobOptions(def),
      jobId: opts.idempotencyKey,
      delay: opts.delayMs,
      priority: opts.priority,
    });
    return job.id as string;
  }

  async cancel(queue: string, jobId: string): Promise<boolean> {
    const source = this.queue?.getJob ? (this.queue as Queue) : this.entry(queue).queue;
    const job = await source.getJob(jobId);
    if (!job) return false;
    // Only pending/delayed/prioritized jobs are cancellable; an active job is
    // left to finish (cancellation is not preemptive mid-execution).
    const state = typeof job.getState === "function" ? await job.getState() : "waiting";
    if (state === "active" || state === "completed" || state === "failed") return false;
    try {
      await job.remove();
      return true;
    } catch (err) {
      this.logger.warn(`[jobs] ${queue}: failed to cancel job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async schedule<T>(
    defOrQueue: JobDefinition<T> | string,
    everyMsOrDefOrOpts: number | JobDefinition<T> | { everyMs: number; data: T },
    dataOrOpts?: T | { everyMs: number; data: T },
  ): Promise<void> {
    let def: JobDefinition<T>;
    let everyMs: number;
    let data: T;
    if (typeof defOrQueue === "string") {
      def = everyMsOrDefOrOpts as JobDefinition<T>;
      const opts = dataOrOpts as { everyMs: number; data: T };
      everyMs = opts.everyMs;
      data = opts.data;
    } else if (typeof everyMsOrDefOrOpts === "number") {
      def = defOrQueue;
      everyMs = everyMsOrDefOrOpts;
      data = dataOrOpts as T;
    } else {
      def = defOrQueue;
      const opts = everyMsOrDefOrOpts as { everyMs: number; data: T };
      everyMs = opts.everyMs;
      data = opts.data;
    }
    await this.entry(def.queue).queue.upsertJobScheduler(
      def.name,
      { every: everyMs },
      { name: def.name, data, opts: this.jobOptions(def) },
    );
  }

  process<T>(def: JobDefinition<T>, handler: JobHandler<T>, events: JobEvents): void {
    const { settings, dlq } = this.entry(def.queue);
    const byName = this.handlers.get(def.queue) ?? new Map();
    byName.set(def.name, { handler: handler as JobHandler<unknown>, events, def });
    this.handlers.set(def.queue, byName);
    if (this.workers.has(def.queue)) return;

    const worker = new Worker(
      def.queue,
      async (job: Job) => {
        const entry = byName.get(job.name);
        if (!entry) throw new Error(`No handler for job "${job.name}" on queue "${def.queue}"`);
        const started = Date.now();
        try {
          await entry.handler(job.data, { jobId: job.id as string, attempt: job.attemptsMade + 1 });
          entry.events.onComplete(entry.def, Date.now() - started);
        } catch (err) {
          const willRetry = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
          entry.events.onFailure(entry.def, Date.now() - started, willRetry);
          if (!willRetry) {
            await dlq.add(job.name, {
              jobId: job.id,
              data: job.data,
              error: err instanceof Error ? err.message : String(err),
              attempts: job.attemptsMade + 1,
              failedAt: new Date().toISOString(),
              def: {
                queue: entry.def.queue,
                name: entry.def.name,
                attempts: entry.def.attempts,
                backoffMs: entry.def.backoffMs,
              },
            });
          }
          throw err;
        }
      },
      {
        connection: { url: this.redisUrl },
        concurrency: settings.concurrency,
        limiter: settings.rateLimit
          ? { max: settings.rateLimit.max, duration: settings.rateLimit.durationMs }
          : undefined,
      },
    );
    worker.on("error", (err) => this.logger.error(`[jobs] worker ${def.queue} error: ${err.message}`));
    this.workers.set(def.queue, worker);
  }

  async stats(name: string): Promise<QueueStats> {
    const { queue, dlq } = this.entry(name);
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
    return {
      queue: name,
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      deadLetter: await dlq.count(),
    };
  }

  async deadLetters(name: string, limit = 100): Promise<DeadLetter[]> {
    const jobs = await this.entry(name).dlq.getJobs(["waiting", "delayed", "prioritized"], 0, limit - 1);
    return jobs.map((job) => ({
      jobId: String(job.data.jobId),
      name: job.name,
      data: job.data.data,
      error: job.data.error,
      attempts: job.data.attempts,
      failedAt: job.data.failedAt,
    }));
  }

  async retryDeadLetter(name: string, jobId: string): Promise<boolean> {
    const { queue, dlq } = this.entry(name);
    const jobs = await dlq.getJobs(["waiting", "delayed", "prioritized", "failed", "completed"]);
    const dlJob = jobs.find((job) => String(job.data?.jobId) === jobId);
    if (!dlJob) return false;

    const stored = dlJob.data?.def as Partial<JobDefinition> | undefined;
    const registered = this.handlers.get(name)?.get(dlJob.name)?.def;
    const def: JobDefinition = {
      queue: stored?.queue ?? registered?.queue ?? name,
      name: stored?.name ?? registered?.name ?? dlJob.name,
      attempts: stored?.attempts ?? registered?.attempts ?? 1,
      backoffMs: stored?.backoffMs ?? registered?.backoffMs ?? 0,
    };

    // Re-enqueue with a fresh job id so the attempt counter resets to the full budget.
    await queue.add(def.name, dlJob.data?.data, this.jobOptions(def));
    await dlJob.remove();
    return true;
  }

  async getResult(name: string, jobId: string): Promise<JobResult> {
    const { queue } = this.entry(name);
    const job = await queue.getJob(jobId);
    if (!job) return { status: "pending" };

    const state = await job.getState();
    switch (state) {
      case "completed":
        return { status: "completed", result: job.returnvalue };
      case "failed":
        return { status: "failed", error: job.failedReason };
      case "active":
        return { status: "active" };
      default:
        return { status: "pending" };
    }
  }

  async listSchedules(name: string): Promise<JobSchedule[]> {
    const schedulers = await this.entry(name).queue.getJobSchedulers();
    return schedulers.map((scheduler) => ({
      name: scheduler.name ?? scheduler.key,
      everyMs: typeof scheduler.every === "number" ? scheduler.every : Number(scheduler.every) || 0,
    }));
  }

  async unschedule(name: string, scheduleName: string): Promise<boolean> {
    const { queue } = this.entry(name);
    const schedulers = await queue.getJobSchedulers();
    const exists = schedulers.some((scheduler) => (scheduler.name ?? scheduler.key) === scheduleName);
    if (!exists) return false;
    await queue.removeJobScheduler(scheduleName);
    return true;
  }

  async close(timeoutMs = 1_000): Promise<void> {
    await Promise.all(
      [...this.workers.entries()].map(async ([name, worker]) => {
        let timeout: NodeJS.Timeout | undefined;
        const graceful = worker.close().then(() => true);
        const timedOut = new Promise<boolean>((resolve) => (timeout = setTimeout(() => resolve(false), timeoutMs)));
        const finished = await Promise.race([graceful, timedOut]);
        clearTimeout(timeout);
        if (!finished) {
          this.logger.warn(`[jobs] ${name}: in-flight jobs did not finish in ${timeoutMs}ms; returning them to the queue`);
          await worker.close(true);
        }
      }),
    );
    await Promise.all(
      [...this.queueMap.values()].flatMap(({ queue, dlq }) => [queue.close(), dlq.close()]),
    );
  }

  queues(): string[] {
    return [...this.queueMap.keys()];
  }

  /** Source and DLQ queues, for Bull Board. */
  bullQueues(): Queue[] {
    return [...this.queueMap.values()].flatMap(({ queue, dlq }) => [queue, dlq]);
  }

  private entry(name: string) {
    const entry = this.queueMap.get(name);
    if (!entry) throw new Error(`Unknown job queue "${name}" — call defineQueue() first`);
    return entry;
  }

  private jobOptions(def: JobDefinition) {
    return {
      attempts: def.attempts,
      backoff: { type: "exponential" as const, delay: def.backoffMs },
      removeOnComplete: { age: COMPLETED_RETENTION_SECONDS },
      // The DLQ keeps the record; the failed original can go.
      removeOnFail: true,
    };
  }
}
