import { Logger } from "@nestjs/common";
import {
  ChainStep,
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

/** Mirrors BullMQ's COMPLETED_RETENTION_SECONDS so both drivers age out results alike. */
const COMPLETED_RETENTION_SECONDS = 86_400;

interface MemJob {
  id: string;
  def: JobDefinition;
  data: unknown;
  attempt: number;
  idempotencyKey?: string;
  priority?: number;
  /** Invoked once this specific job completes successfully (chain advancement). */
  onComplete?: () => void;
}

interface MemDeadLetter extends DeadLetter {
  /** Original definition, kept so a retry can re-run with the full attempts budget. */
  def: JobDefinition;
}

interface MemResult {
  status: "pending" | "active" | "completed" | "failed";
  result?: unknown;
  error?: string;
  expiresAt: number;
}

interface MemSchedule {
  timer: NodeJS.Timeout;
  everyMs: number;
}

interface MemQueue {
  settings: QueueSettings;
  waiting: MemJob[];
  delayed: Set<NodeJS.Timeout>;
  /** Delayed jobs keyed by their timer, so cancel() can find and clear them. */
  delayedJobs: Map<NodeJS.Timeout, MemJob>;
  delayedCount: number;
  active: Map<string, MemJob>;
  inFlight: Set<Promise<void>>;
  handlers: Map<string, { handler: JobHandler<unknown>; events: JobEvents }>;
  dlq: MemDeadLetter[];
  /** Start timestamps inside the current rate-limit window. */
  rateWindow: number[];
  rateTimer?: NodeJS.Timeout;
  pumpScheduled?: boolean;
}

const NOOP_EVENTS: JobEvents = {
  onComplete: () => undefined,
  onFailure: () => undefined,
};

/**
 * Single-process, non-durable driver for development and tests. Implements
 * the same retry / DLQ / idempotency / concurrency / rate-limit semantics as
 * the BullMQ driver so behaviour can be tested without Redis.
 */
export class MemoryJobQueueDriver implements JobQueueDriver {
  private readonly logger = new Logger(MemoryJobQueueDriver.name);
  private readonly queueMap = new Map<string, MemQueue>();
  private readonly idempotency = new Map<string, string>();
  private readonly schedules = new Map<string, MemSchedule>();
  private readonly results = new Map<string, MemResult>();
  private seq = 0;
  private closing = false;

  defineQueue(queue: string, settings: QueueSettings): void {
    const existing = this.queueMap.get(queue);
    if (existing) {
      existing.settings = settings;
      return;
    }
    this.queueMap.set(queue, {
      settings,
      waiting: [],
      delayed: new Set(),
      delayedJobs: new Map(),
      delayedCount: 0,
      active: new Map(),
      inFlight: new Set(),
      handlers: new Map(),
      dlq: [],
      rateWindow: [],
    });
  }

  register<T, R = unknown>(queue: string, def: JobDefinition<T, R>, handler: JobHandler<T, R>): void {
    this.defineQueue(queue, { concurrency: 1 });
    this.process(def, handler, NOOP_EVENTS);
  }

  async start(queue: string, settings: QueueSettings): Promise<void> {
    this.defineQueue(queue, settings);
    this.pump(queue);
  }

  async enqueue<T>(
    defOrQueue: JobDefinition<T> | string,
    dataOrDef: T | JobDefinition<T> | string,
    optsOrData?: EnqueueOptions | T,
    maybeOpts?: EnqueueOptions,
  ): Promise<string> {
    return this.enqueueInternal(defOrQueue, dataOrDef, optsOrData, maybeOpts);
  }

  private enqueueInternal<T>(
    defOrQueue: JobDefinition<T> | string,
    dataOrDef: T | JobDefinition<T> | string,
    optsOrData?: EnqueueOptions | T,
    maybeOpts?: EnqueueOptions,
    onComplete?: () => void,
  ): string {
    let def: JobDefinition<T>;
    let data: T;
    let opts: EnqueueOptions;
    if (typeof defOrQueue === "string") {
      if (typeof dataOrDef === "object" && dataOrDef !== null && "queue" in dataOrDef && "name" in dataOrDef) {
        def = dataOrDef as JobDefinition<T>;
      } else {
        def = { queue: defOrQueue, name: String(dataOrDef), attempts: 5, backoffMs: 1_000 };
      }
      data = optsOrData as T;
      opts = maybeOpts ?? {};
    } else {
      def = defOrQueue;
      data = dataOrDef as T;
      opts = (optsOrData as EnqueueOptions | undefined) ?? {};
    }

    const q = this.queue(def.queue);
    const dedupe = opts.idempotencyKey ? `${def.queue}:${opts.idempotencyKey}` : undefined;
    const existing = dedupe ? this.idempotency.get(dedupe) : undefined;
    if (existing) return existing;

    const id = opts.idempotencyKey ?? `${def.name}:${++this.seq}`;
    if (dedupe) this.idempotency.set(dedupe, id);
    const job: MemJob = {
      id,
      def,
      data,
      attempt: 1,
      idempotencyKey: opts.idempotencyKey,
      priority: opts.priority,
      onComplete,
    };
    this.setResult(def.queue, id, { status: "pending" });
    if (opts.delayMs) this.delay(q, def.queue, job, opts.delayMs);
    else {
      q.waiting.push(job);
      this.pump(def.queue);
    }
    return id;
  }

  async enqueueChain<T>(steps: { def: JobDefinition<T>; data: T; opts?: EnqueueOptions }[]): Promise<string> {
    if (steps.length === 0) throw new Error("enqueueChain() requires at least one step");
    return this.enqueueStep(steps, 0);
  }

  /**
   * Enqueue `steps[index]` and arrange for `steps[index + 1]` to be enqueued
   * only once this step completes successfully. On final failure the next
   * step is never enqueued, so the chain is abandoned and the failure is
   * visible via the dead-letter list for the step that failed.
   */
  private enqueueStep<T>(steps: { def: JobDefinition<T>; data: T; opts?: EnqueueOptions }[], index: number): string {
    const step = steps[index];
    const onComplete =
      index + 1 < steps.length ? () => this.enqueueStep(steps, index + 1) : undefined;
    return this.enqueueInternal(step.def, step.data, step.opts, undefined, onComplete);
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
      const o = dataOrOpts as { everyMs: number; data: T };
      everyMs = o.everyMs;
      data = o.data;
    } else if (typeof everyMsOrDefOrOpts === "object" && everyMsOrDefOrOpts !== null && "everyMs" in everyMsOrDefOrOpts) {
      def = defOrQueue;
      everyMs = everyMsOrDefOrOpts.everyMs;
      data = everyMsOrDefOrOpts.data;
    } else {
      def = defOrQueue;
      everyMs = everyMsOrDefOrOpts as number;
      data = dataOrOpts as T;
    }
    const key = `${def.queue}:${def.name}`;
    if (this.schedules.has(key)) return;
    const timer = setInterval(() => {
      // Nothing consumes this queue in this process — don't pile up jobs.
      if (!this.queue(def.queue).handlers.has(def.name) || this.closing) return;
      void this.enqueue(def, data);
    }, everyMs);
    timer.unref?.();
    this.schedules.set(key, { timer, everyMs });
  }

  async listSchedules(queue: string): Promise<JobSchedule[]> {
    const prefix = `${queue}:`;
    const out: JobSchedule[] = [];
    for (const [key, sched] of this.schedules) {
      if (!key.startsWith(prefix)) continue;
      out.push({ name: key.slice(prefix.length), everyMs: sched.everyMs });
    }
    return out;
  }

  async unschedule(queue: string, name: string): Promise<boolean> {
    const key = `${queue}:${name}`;
    const sched = this.schedules.get(key);
    if (!sched) return false;
    clearInterval(sched.timer);
    this.schedules.delete(key);
    return true;
  }

  process<T, R = unknown>(def: JobDefinition<T, R>, handler: JobHandler<T, R>, events: JobEvents): void {
    this.queue(def.queue).handlers.set(def.name, {
      handler: handler as JobHandler<unknown>,
      events,
    });
    this.pump(def.queue);
  }

  async stats(queue: string): Promise<QueueStats> {
    const q = this.queue(queue);
    return {
      queue,
      waiting: q.waiting.length,
      active: q.active.size,
      delayed: q.delayedCount,
      deadLetter: q.dlq.length,
    };
  }

  async deadLetters(queue: string, limit = 100): Promise<DeadLetter[]> {
    return this.queue(queue)
      .dlq.slice(-limit)
      .reverse()
      .map(({ def: _def, ...rest }) => rest);
  }

  async cancel(queue: string, jobId: string): Promise<boolean> {
    const q = this.queue(queue);
    const idx = q.waiting.findIndex((j) => j.id === jobId);
    if (idx !== -1) {
      q.waiting.splice(idx, 1);
      return true;
    }
    for (const [timer, job] of q.delayedJobs) {
      if (job.id !== jobId) continue;
      clearTimeout(timer);
      q.delayed.delete(timer);
      q.delayedJobs.delete(timer);
      q.delayedCount--;
      return true;
    }
    // Active jobs are left to finish — cancellation is not preemptive.
    return false;
  }

  async retryDeadLetter(queue: string, jobId: string): Promise<boolean> {
    if (!this.queueMap.has(queue)) return false;
    const q = this.queue(queue);
    const idx = q.dlq.findIndex((d) => d.jobId === jobId);
    if (idx === -1) return false;
    const [entry] = q.dlq.splice(idx, 1);
    // Fresh attempt counter so the retry gets the full attempts budget again.
    const job: MemJob = { id: entry.jobId, def: entry.def, data: entry.data, attempt: 1 };
    this.setResult(queue, job.id, { status: "pending" });
    q.waiting.push(job);
    this.pump(queue);
    return true;
  }

  async getResult(queue: string, jobId: string): Promise<JobResult> {
    if (this.queueMap.has(queue)) {
      this.queue(queue);
    }
    const entry = this.results.get(jobId);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.results.delete(jobId);
      return { status: "pending" };
    }
    const { expiresAt: _expiresAt, ...rest } = entry;
    return rest;
  }

  async close(timeoutMs = 1_000): Promise<void> {
    this.closing = true;
    for (const sched of this.schedules.values()) clearInterval(sched.timer);
    const inFlight = [...this.queueMap.values()].flatMap((q) => [...q.inFlight]);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise((resolve) => (timeout = setTimeout(resolve, timeoutMs))),
    ]);
    clearTimeout(timeout);
    for (const [name, q] of this.queueMap) {
      for (const t of q.delayed) clearTimeout(t);
      q.delayedJobs.clear();
      if (q.rateTimer) clearTimeout(q.rateTimer);
      if (q.active.size > 0) {
        // Return unfinished jobs to the head of the queue.
        q.waiting.unshift(...q.active.values());
        this.logger.warn(`[jobs] returned ${q.active.size} in-flight job(s) on ${name} at shutdown`);
        q.active.clear();
      }
    }
  }

  queues(): string[] {
    return [...this.queueMap.keys()];
  }

  private setResult(queue: string, jobId: string, update: Omit<MemResult, "expiresAt">): void {
    this.evictExpiredResults();
    this.results.set(jobId, {
      ...update,
      expiresAt: Date.now() + COMPLETED_RETENTION_SECONDS * 1000,
    });
  }

  private evictExpiredResults(): void {
    const now = Date.now();
    for (const [id, entry] of this.results) {
      if (entry.expiresAt <= now) this.results.delete(id);
    }
  }

  private queue(name: string): MemQueue {
    const q = this.queueMap.get(name);
    if (!q) throw new Error(`Unknown job queue "${name}" — call defineQueue() first`);
    return q;
  }

  private delay(q: MemQueue, queue: string, job: MemJob, ms: number) {
    q.delayedCount++;
    const timer = setTimeout(() => {
      q.delayed.delete(timer);
      q.delayedJobs.delete(timer);
      q.delayedCount--;
      q.waiting.push(job);
      this.pump(queue);
    }, ms);
    timer.unref?.();
    q.delayed.add(timer);
    q.delayedJobs.set(timer, job);
  }

  private pump(queue: string): void {
    const q = this.queue(queue);
    if (q.pumpScheduled) return;
    q.pumpScheduled = true;
    queueMicrotask(() => {
      q.pumpScheduled = false;
      this.drain(queue);
    });
  }

  private drain(queue: string): void {
    const q = this.queue(queue);
    while (!this.closing && q.active.size < q.settings.concurrency) {
      const idx = this.nextIndex(q);
      if (idx === -1) return;
      if (!this.takeRateSlot(q, queue)) return;
      const [job] = q.waiting.splice(idx, 1);
      q.active.set(job.id, job);
      const run = this.run(q, queue, job).finally(() => {
        q.inFlight.delete(run);
        this.pump(queue);
      });
      q.inFlight.add(run);
    }
  }

  /**
   * Stable selection of the next runnable job: lowest priority value wins
   * (undefined = normal), ties broken by insertion order. Scanning for the
   * minimum rather than sorting keeps equal-priority jobs in their original
   * order and prevents any priority class from starving.
   */
  private nextIndex(q: MemQueue): number {
    let best = -1;
    let bestPriority = Infinity;
    for (let i = 0; i < q.waiting.length; i++) {
      const job = q.waiting[i];
      if (!q.handlers.has(job.def.name)) continue;
      const priority = job.priority ?? Infinity;
      if (best === -1 || priority < bestPriority) {
        best = i;
        bestPriority = priority;
      }
    }
    return best;
  }

  private takeRateSlot(q: MemQueue, queue: string): boolean {
    const limit = q.settings.rateLimit;
    if (!limit) return true;
    const now = Date.now();
    q.rateWindow = q.rateWindow.filter((t) => now - t < limit.durationMs);
    if (q.rateWindow.length < limit.max) {
      q.rateWindow.push(now);
      return true;
    }
    if (!q.rateTimer) {
      q.rateTimer = setTimeout(() => {
        q.rateTimer = undefined;
        this.pump(queue);
      }, limit.durationMs - (now - q.rateWindow[0]));
      q.rateTimer.unref?.();
    }
    return false;
  }

  private async run(q: MemQueue, queue: string, job: MemJob): Promise<void> {
    const { handler, events } = q.handlers.get(job.def.name)!;
    const started = Date.now();
    this.setResult(queue, job.id, { status: "active" });
    try {
      const result = await handler(job.data, { jobId: job.id, attempt: job.attempt });
      if (!q.active.delete(job.id)) return; // returned to the queue by close()
      this.setResult(queue, job.id, { status: "completed", result });
      events.onComplete(job.def, Date.now() - started);
      job.onComplete?.();
    } catch (err) {
      if (!q.active.delete(job.id)) return;
      const willRetry = job.attempt < job.def.attempts;
      events.onFailure(job.def, Date.now() - started, willRetry);
      if (willRetry) {
        this.setResult(queue, job.id, { status: "pending" });
        const backoff = job.def.backoffMs * 2 ** (job.attempt - 1);
        this.delay(q, queue, { ...job, attempt: job.attempt + 1 }, backoff);
      } else {
        const error = err instanceof Error ? err.message : String(err);
        this.setResult(queue, job.id, { status: "failed", error });
        q.dlq.push({
          jobId: job.id,
          name: job.def.name,
          data: job.data,
          error,
          attempts: job.attempt,
          failedAt: new Date().toISOString(),
          def: job.def,
        });
      }
    }
  }
}
