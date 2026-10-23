import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { JobsService } from "./jobs.service";
import { defineJob, JobQueueDriver } from "./jobs.types";
import { MemoryJobQueueDriver } from "./memory-job-queue.driver";
import { BullMqJobQueueDriver } from "./bullmq-job-queue.driver";

function config(overrides: Partial<Pick<AppConfig, "processRole">> = {}, shutdownTimeoutMs = 1_000) {
  const values: Partial<AppConfig> = {
    processRole: "all",
    jobs: { driver: "memory", shutdownTimeoutMs },
    redisUrl: "redis://localhost:6379",
    ...overrides,
  };
  return { get: (key: keyof AppConfig) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await sleep(5);
  }
}

const JOB = defineJob<{ n: number }>("test", "work", { attempts: 3, backoffMs: 10 });

describe("JobsService (memory driver)", () => {
  let service: JobsService;
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService({ get: () => undefined } as unknown as ConfigService<AppConfig, true>);
    service = new JobsService(config(), metrics, new MemoryJobQueueDriver());
    service.defineQueue("test", { concurrency: 2 });
  });

  afterEach(() => service.onApplicationShutdown());

  it("retries with exponential backoff and succeeds", async () => {
    const attemptTimes: number[] = [];
    service.process(JOB, async (_data, ctx) => {
      attemptTimes.push(Date.now());
      if (ctx.attempt < 3) throw new Error("transient");
    });

    await service.enqueue(JOB, { n: 1 });
    await waitFor(() => attemptTimes.length === 3);

    // backoff = 10ms, then 20ms
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(9);
    expect(attemptTimes[2] - attemptTimes[1]).toBeGreaterThanOrEqual(19);
    await waitFor(async () => (await service.stats())[0].delayed === 0);
    expect((await service.stats())[0].deadLetter).toBe(0);
    expect(await metrics.metrics()).toContain('vortex_jobs_failures_total{queue="test",job="work"} 2');
  });

  it("moves a job to the DLQ after exhausting attempts", async () => {
    const handler = jest.fn().mockRejectedValue(new Error("boom"));
    service.process(JOB, handler);

    const id = await service.enqueue(JOB, { n: 7 });
    await waitFor(async () => (await service.deadLetters("test")).length === 1);

    expect(handler).toHaveBeenCalledTimes(3);
    const [dead] = await service.deadLetters("test");
    expect(dead).toMatchObject({ jobId: id, name: "work", data: { n: 7 }, error: "boom", attempts: 3 });
    const text = await metrics.metrics();
    expect(text).toContain('vortex_jobs_dead_lettered_total{queue="test",job="work"} 1');
    expect(text).toContain('vortex_jobs_queue_depth{queue="test",state="dead_letter"} 1');
  });

  it("deduplicates by idempotency key", async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    service.process(JOB, handler);

    const a = await service.enqueue(JOB, { n: 1 }, { idempotencyKey: "k1" });
    const b = await service.enqueue(JOB, { n: 2 }, { idempotencyKey: "k1" });
    await waitFor(() => handler.mock.calls.length >= 1);
    await sleep(20);

    expect(a).toBe(b);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("respects per-queue concurrency", async () => {
    let running = 0;
    let peak = 0;
    service.process(JOB, async () => {
      peak = Math.max(peak, ++running);
      await sleep(15);
      running--;
    });

    await Promise.all([1, 2, 3, 4, 5].map((n) => service.enqueue(JOB, { n })));
    await waitFor(async () => {
      const [s] = await service.stats();
      return s.waiting === 0 && s.active === 0;
    });
    expect(peak).toBe(2);
  });

  it("rate-limits job starts per queue", async () => {
    service.defineQueue("limited", { concurrency: 10, rateLimit: { max: 2, durationMs: 50 } });
    const LIMITED = defineJob<{ n: number }>("limited", "work");
    const starts: number[] = [];
    service.process(LIMITED, async () => {
      starts.push(Date.now());
    });

    await Promise.all([1, 2, 3].map((n) => service.enqueue(LIMITED, { n })));
    await waitFor(() => starts.length === 3);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(40);
  });

  it("does not consume jobs in the api role (producers only)", async () => {
    const api = new JobsService(config({ processRole: "api" }), undefined, new MemoryJobQueueDriver());
    api.defineQueue("test", { concurrency: 1 });
    const handler = jest.fn();
    api.process(JOB, handler);

    await api.enqueue(JOB, { n: 1 });
    await sleep(20);

    expect(handler).not.toHaveBeenCalled();
    expect((await api.stats())[0].waiting).toBe(1);
    await api.onApplicationShutdown();
  });
});

describe("JobsService priority ordering", () => {
  it("picks up a high-priority job enqueued after several low-priority ones first (memory driver)", async () => {
    const service = new JobsService(config(), undefined, new MemoryJobQueueDriver());
    service.defineQueue("test", { concurrency: 1 });
    const order: number[] = [];
    service.process(JOB, async (data) => {
      order.push(data.n);
    });

    // Fill the queue while nothing can be consumed yet by enqueuing before processing starts.
    await service.enqueue(JOB, { n: 1 }, { priority: 10 });
    await service.enqueue(JOB, { n: 2 }, { priority: 10 });
    await service.enqueue(JOB, { n: 3 }, { priority: 10 });
    await service.enqueue(JOB, { n: 4 }, { priority: 1 });

    await waitFor(() => order.length === 4);
    expect(order[0]).toBe(4);
    expect(order.slice(1)).toEqual([1, 2, 3]);
    await service.onApplicationShutdown();
  });

  it("passes priority through to BullMQ's native job option", async () => {
    const add = jest.fn().mockResolvedValue({ id: "job-1" });
    const queue = { add, getJob: jest.fn().mockResolvedValue(undefined) };
    const driver = new BullMqJobQueueDriver({ get: () => "redis://localhost:6379" } as unknown as ConfigService<AppConfig, true>);
    // Inject a fake BullMQ queue to observe the options passed to add().
    (driver as unknown as { queue: unknown }).queue = queue;

    await driver.enqueue("test", "work", { n: 1 }, { priority: 3 });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][2]).toMatchObject({ priority: 3 });
  });
});

describe("JobsService cancellation", () => {
  function makeService(driver: JobQueueDriver) {
    const service = new JobsService(config(), undefined, driver);
    service.defineQueue("test", { concurrency: 1 });
    return service;
  }

  it("cancels a waiting job on the memory driver", async () => {
    const driver = new MemoryJobQueueDriver();
    const service = makeService(driver);
    const handler = jest.fn();
    service.process(JOB, handler);

    const id = await service.enqueue(JOB, { n: 1 });
    expect(await service.cancel("test", id)).toBe(true);
    await sleep(20);

    expect(handler).not.toHaveBeenCalled();
    expect((await service.stats())[0].waiting).toBe(0);
    await service.onApplicationShutdown();
  });

  it("cancels a delayed job on the memory driver", async () => {
    const driver = new MemoryJobQueueDriver();
    const service = makeService(driver);
    const handler = jest.fn();
    service.process(JOB, handler);

    const id = await service.enqueue(JOB, { n: 1 }, { delayMs: 50 });
    expect(await service.cancel("test", id)).toBe(true);
    await sleep(80);

    expect(handler).not.toHaveBeenCalled();
    await service.onApplicationShutdown();
  });

  it("returns false when cancelling an unknown job id", async () => {
    const driver = new MemoryJobQueueDriver();
    const service = makeService(driver);

    expect(await service.cancel("test", "does-not-exist")).toBe(false);
    await service.onApplicationShutdown();
  });

  it("does not cancel an active job (no-op returning false)", async () => {
    const driver = new MemoryJobQueueDriver();
    const service = makeService(driver);
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      service.process(JOB, async () => {
        resolve();
        await new Promise<void>((r) => (release = r));
      });
    });

    const id = await service.enqueue(JOB, { n: 1 });
    await started;
    expect(await service.cancel("test", id)).toBe(false);
    release();
    await waitFor(async () => (await service.stats())[0].active === 0);
    await service.onApplicationShutdown();
  });

  it("cancels a waiting job on the BullMQ driver", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({ id: "job-1", remove });
    const driver = new BullMqJobQueueDriver({ get: () => "redis://localhost:6379" } as unknown as ConfigService<AppConfig, true>);
    (driver as unknown as { queue: unknown }).queue = { getJob };

    expect(await driver.cancel("test", "job-1")).toBe(true);
    expect(getJob).toHaveBeenCalledWith("job-1");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("returns false on the BullMQ driver when the job is unknown", async () => {
    const getJob = jest.fn().mockResolvedValue(undefined);
    const driver = new BullMqJobQueueDriver({ get: () => "redis://localhost:6379" } as unknown as ConfigService<AppConfig, true>);
    (driver as unknown as { queue: unknown }).queue = { getJob };

    expect(await driver.cancel("test", "missing")).toBe(false);
  });
});

describe("JobsService graceful shutdown", () => {
  it("waits for in-flight jobs to finish", async () => {
    const service = new JobsService(config({}, 1_000), undefined, new MemoryJobQueueDriver());
    service.defineQueue("test", { concurrency: 1 });
    let finished = false;
    service.process(JOB, async () => {
      await sleep(30);
      finished = true;
    });

    await service.enqueue(JOB, { n: 1 });
    await waitFor(async () => (await service.stats())[0].active === 1);
    await service.onApplicationShutdown();

    expect(finished).toBe(true);
    expect((await service.stats())[0]).toMatchObject({ waiting: 0, active: 0 });
  });

  it("returns jobs that outlive the timeout to the queue and stops pulling new ones", async () => {
    const service = new JobsService(config({}, 20), undefined, new MemoryJobQueueDriver());
    service.defineQueue("test", { concurrency: 1 });
    const handler = jest.fn(async () => {
      await sleep(200);
    });
    service.process(JOB, handler);

    await service.enqueue(JOB, { n: 1 });
    await service.enqueue(JOB, { n: 2 });
    await waitFor(async () => (await service.stats())[0].active === 1);
    await service.onApplicationShutdown();

    expect((await service.stats())[0]).toMatchObject({ waiting: 2, active: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
