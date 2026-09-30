import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { JobsService } from "./jobs.service";
import { defineJob } from "./jobs.types";
import { MemoryJobQueueDriver } from "./memory-job-queue.driver";

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
