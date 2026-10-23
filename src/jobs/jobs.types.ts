/**
 * Typed job definition. `TData` is a phantom type binding producers and the
 * handler to the same payload shape; create one with {@link defineJob}.
 */
export interface JobDefinition<TData = unknown, TResult = unknown> {
  /** Job name, unique within its queue. */
  name: string;
  /** Queue the job runs on; per-queue concurrency / rate limits apply. */
  queue: string;
  /** Total attempts including the first (default 5). */
  attempts: number;
  /** Base delay for exponential backoff: delay = backoffMs * 2^(attempt - 1). */
  backoffMs: number;
  /** @internal phantom field — never set at runtime. */
  readonly __data?: TData;
  /** @internal phantom field — never set at runtime. */
  readonly __result?: TResult;
}

/** Declares a typed job. Payloads must be JSON-serialisable. */
export function defineJob<TData = unknown, TResult = unknown>(
  queueOrOpts: string | { queue: string; name: string; attempts?: number; backoffMs?: number },
  name?: string,
  opts: { attempts?: number; backoffMs?: number } = {},
): JobDefinition<TData, TResult> {
  if (typeof queueOrOpts === "object") {
    return {
      queue: queueOrOpts.queue,
      name: queueOrOpts.name,
      attempts: queueOrOpts.attempts ?? 5,
      backoffMs: queueOrOpts.backoffMs ?? 1_000,
    };
  }
  return { queue: queueOrOpts, name: name ?? "", attempts: opts.attempts ?? 5, backoffMs: opts.backoffMs ?? 1_000 };
}

/** Per-queue worker settings. */
export interface QueueSettings {
  /** Max jobs processed concurrently per worker process. */
  concurrency: number;
  /** Optional rate limit: at most `max` jobs per `durationMs` (shared across workers on BullMQ). */
  rateLimit?: { max: number; durationMs: number };
}

export interface EnqueueOptions {
  /**
   * Deduplication key: while a job with the same key is waiting, active or
   * completed within the retention window (24 h on BullMQ; process lifetime
   * on the memory driver), a second enqueue is a no-op returning the
   * existing job id.
   */
  idempotencyKey?: string;
  delayMs?: number;
  /**
   * Ordering within the queue: lower number = higher priority (BullMQ
   * convention). Unset/`undefined` means normal priority. Jobs with equal
   * priority are processed in insertion order.
   */
  priority?: number;
}

export interface JobContext {
  jobId: string;
  /** 1-based attempt number. */
  attempt: number;
}

/**
 * Job handler. The resolved value is captured as the job's result and can be
 * retrieved later via {@link JobQueueDriver.getResult}. Handlers that return
 * nothing (`void`) remain fully supported.
 */
export type JobHandler<TData, TResult = unknown> = (
  data: TData,
  ctx: JobContext,
) => Promise<TResult>;

/** Snapshot of one queue for metrics and the admin API. */
export interface QueueStats {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  deadLetter: number;
}

/** A job that exhausted its retries. */
export interface DeadLetter {
  jobId: string;
  name: string;
  data: unknown;
  error: string;
  attempts: number;
  failedAt: string;
  /** Queue the job originally ran on (source queue for a retry). */
  queue?: string;
  /**
   * Enough of the original {@link JobDefinition} to reconstruct it when
   * retrying the job (attempts / backoff are re-applied from here).
   */
  def?: Pick<JobDefinition, "name" | "queue" | "attempts" | "backoffMs">;
}

/** Outcome of a job-status lookup. */
export interface JobResult {
  status: "pending" | "active" | "completed" | "failed" | "not_found";
  /** Resolved handler value, present when `status === "completed"`. */
  result?: unknown;
  /** Failure reason, present when `status === "failed"`. */
  error?: string;
}

/** A repeating job schedule registered via {@link JobQueueDriver.schedule}. */
export interface JobSchedule {
  name: string;
  everyMs: number;
}

/** Hooks the service installs on a driver to emit per-job metrics. */
export interface JobEvents {
  onComplete(def: JobDefinition, durationMs: number): void;
  onFailure(def: JobDefinition, durationMs: number, willRetry: boolean): void;
}

/** Storage/execution backend behind {@link JobsService}. */
export interface JobQueueDriver {
  defineQueue(queue: string, settings: QueueSettings): void;
  enqueue<T>(def: JobDefinition<T>, data: T, opts?: EnqueueOptions): Promise<string>;
  enqueue<T>(queue: string, defOrName: JobDefinition<T> | string, data: T, opts?: EnqueueOptions): Promise<string>;
  /** Repeating job; idempotent per job name. */
  schedule<T>(def: JobDefinition<T>, everyMs: number, data: T): Promise<void>;
  schedule<T>(def: JobDefinition<T>, opts: { everyMs: number; data: T }): Promise<void>;
  schedule<T>(queue: string, def: JobDefinition<T>, opts: { everyMs: number; data: T }): Promise<void>;
  /** Registers the consumer and starts pulling jobs for `def.queue`. */
  process<T, R = unknown>(def: JobDefinition<T, R>, handler: JobHandler<T, R>, events: JobEvents): void;
  register?<T, R = unknown>(queue: string, def: JobDefinition<T, R>, handler: JobHandler<T, R>): void;
  start?(queue: string, settings: QueueSettings): Promise<void>;
  stats(queue: string): Promise<QueueStats>;
  deadLetters(queue: string, limit?: number): Promise<DeadLetter[]>;
  /**
   * Removes a pending, delayed or scheduled job from `queue`.
   */
  cancel(queue: string, jobId: string): Promise<boolean>;
  /**
   * Re-enqueues a dead-lettered job for another attempt, resetting its attempt
   * counter so it gets the full {@link JobDefinition.attempts} budget again.
   * Removes the record from the dead-letter queue on success.
   */
  retryDeadLetter(queue: string, jobId: string): Promise<boolean>;
  /**
   * Looks up the status (and result/error) of a job by id.
   */
  getResult(queue: string, jobId: string): Promise<JobResult>;
  /** Lists the repeating schedules currently registered on `queue`. */
  listSchedules(queue: string): Promise<JobSchedule[]>;
  /**
   * Cancels a repeating schedule by name. Jobs already enqueued from previous
   * ticks are unaffected.
   */
  unschedule(queue: string, name: string): Promise<boolean>;
  /**
   * Stops pulling new jobs and waits up to `timeoutMs` for in-flight ones.
   * Jobs still running at the deadline are returned to the queue.
   */
  close(timeoutMs?: number): Promise<void>;
  queues(): string[];
}
