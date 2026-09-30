/**
 * Typed job definition. `TData` is a phantom type binding producers and the
 * handler to the same payload shape; create one with {@link defineJob}.
 */
export interface JobDefinition<TData = unknown> {
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
}

/** Declares a typed job. Payloads must be JSON-serialisable. */
export function defineJob<TData>(
  queue: string,
  name: string,
  opts: { attempts?: number; backoffMs?: number } = {},
): JobDefinition<TData> {
  return { queue, name, attempts: opts.attempts ?? 5, backoffMs: opts.backoffMs ?? 1_000 };
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
}

export interface JobContext {
  jobId: string;
  /** 1-based attempt number. */
  attempt: number;
}

export type JobHandler<TData> = (data: TData, ctx: JobContext) => Promise<void>;

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
  /** Repeating job; idempotent per job name. */
  schedule<T>(def: JobDefinition<T>, everyMs: number, data: T): Promise<void>;
  /** Registers the consumer and starts pulling jobs for `def.queue`. */
  process<T>(def: JobDefinition<T>, handler: JobHandler<T>, events: JobEvents): void;
  stats(queue: string): Promise<QueueStats>;
  deadLetters(queue: string, limit?: number): Promise<DeadLetter[]>;
  /**
   * Stops pulling new jobs and waits up to `timeoutMs` for in-flight ones.
   * Jobs still running at the deadline are returned to the queue.
   */
  close(timeoutMs: number): Promise<void>;
  queues(): string[];
}
