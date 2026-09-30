import { ConfigService } from "@nestjs/config";
import { nativeToScVal, type xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { ShadowService, type ShadowObservationRequest } from "./shadow.service";
import { StellarTxService, type SimulateContractResult } from "./stellar-tx.service";
import { SHADOW_TRANSITIONS } from "./shadow.types";

/** A real ScVal so the args match the type the service declares. */
const ARGS: xdr.ScVal[] = [nativeToScVal("intent-1", { type: "string" })];

/** Params the service passes to `simulateContract`. */
interface SimulateParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  sourceAccount?: string;
}

type SimulateFn = (params: SimulateParams) => Promise<SimulateContractResult>;

interface HarnessOptions {
  enabled?: boolean;
  sampleRate?: number;
  queueMax?: number;
  concurrency?: number;
  sourceAccount?: string;
  settlementContractId?: string;
  simulate?: SimulateFn;
}

const SETTLEMENT_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function request(overrides: Partial<ShadowObservationRequest> = {}): ShadowObservationRequest {
  return {
    transition: "accept",
    intentId: "intent-1",
    committed: true,
    method: "accept_intent",
    args: ARGS,
    ...overrides,
  };
}

function buildHarness(options: HarnessOptions = {}) {
  const simulate: SimulateFn = options.simulate ?? (async () => ({ outcome: "ok" }));

  const simulateContract = jest.fn(simulate);
  const stellarTxService = { simulateContract } as unknown as StellarTxService;

  const recordShadowComparison = jest.fn();
  const recordShadowDivergence = jest.fn();
  const recordShadowDrop = jest.fn();
  const setShadowQueueDepth = jest.fn();
  const metricsService = {
    recordShadowComparison,
    recordShadowDivergence,
    recordShadowDrop,
    setShadowQueueDepth,
  } as unknown as MetricsService;

  const shadowConfig = {
    enabled: options.enabled ?? true,
    sampleRate: options.sampleRate ?? 1,
    queueMax: options.queueMax ?? 256,
    concurrency: options.concurrency ?? 1,
    sourceAccount: options.sourceAccount ?? "GBOOTSTRAPSOURCEACCOUNT0000000000000000000000000000000000000000",
  };

  const configService = {
    get: (key: string) => {
      if (key === "shadow") return shadowConfig;
      if (key === "stellar.settlementContractId") {
        return options.settlementContractId ?? SETTLEMENT_CONTRACT_ID;
      }
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;

  const service = new ShadowService(stellarTxService, metricsService, configService);

  return {
    service,
    simulateContract,
    recordShadowComparison,
    recordShadowDivergence,
    recordShadowDrop,
    setShadowQueueDepth,
    /**
     * Mirror of what `IntentsService` does at every call site: ask first,
     * then do the (potentially expensive) work and record.
     */
    submit(req: ShadowObservationRequest = request()): boolean {
      if (!service.shouldObserve()) return false;
      service.observe(req);
      return true;
    },
  };
}

describe("ShadowService — enablement and sampling", () => {
  it("is disabled by default and never queues work", async () => {
    const { service, submit, simulateContract, recordShadowDrop } = buildHarness({ enabled: false });

    expect(service.isEnabled()).toBe(false);
    submit();
    await service.drain();

    expect(simulateContract).not.toHaveBeenCalled();
    expect(recordShadowDrop).not.toHaveBeenCalled();
    // The decline is accounted for, not merely a no-op: this is the signal
    // that distinguishes "monitor off" from "monitor healthy".
    expect(service.queueStats()).toMatchObject({ depth: 0, completed: 0, disabled: 1 });
  });

  it("still reports queue health when disabled, so a dark monitor stays visible", () => {
    const { service, submit } = buildHarness({ enabled: false });
    for (let i = 0; i < 7; i += 1) submit();
    expect(service.report().queue).toMatchObject({ disabled: 7, sampledOut: 0, dropped: 0 });
  });

  it("honours a zero sampling rate", async () => {
    const { service, submit, simulateContract } = buildHarness({ sampleRate: 0 });

    for (let i = 0; i < 20; i += 1) submit();
    await service.drain();

    expect(simulateContract).not.toHaveBeenCalled();
    expect(service.report().queue.sampledOut).toBe(20);
  });

  it("samples roughly the configured fraction", async () => {
    // queueMax is sized to the whole burst: nothing is dropped, so the only
    // thing that can reduce `completed` is sampling.
    const { service, submit } = buildHarness({ sampleRate: 0.5, queueMax: 10_000, concurrency: 64 });

    for (let i = 0; i < 4000; i += 1) submit(request({ intentId: `i-${i}` }));
    await service.drain();

    const { sampledOut, completed, dropped } = service.queueStats();
    // Generous bounds: this asserts the knob is wired up, not that the RNG is
    // perfectly uniform. Exact equality would make the suite flaky.
    expect(sampledOut).toBeGreaterThan(1500);
    expect(sampledOut).toBeLessThan(2500);
    expect(dropped).toBe(0);
    expect(completed).toBe(4000 - sampledOut);
  });

  it("draws the sampling decision exactly once per transition", () => {
    // The caller gates its expensive work on shouldObserve(); observe() must
    // therefore not sample again, or a transition that won the draw would be
    // discarded afterwards and the queue would lose work it was told to keep.
    const { service, submit } = buildHarness({ sampleRate: 0.5 });
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.1);

    expect(submit()).toBe(true);
    expect(service.queueStats()).toMatchObject({ depth: 1, sampledOut: 0 });
    expect(randomSpy).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
  });

  it("swallows an unexpected failure while deciding to observe", () => {
    const { service } = buildHarness({ sampleRate: 0.5 });
    const randomSpy = jest.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => service.shouldObserve()).not.toThrow();
    // Nothing was queued: the failure happened before the enqueue.
    expect(service.queueStats().depth).toBe(0);

    randomSpy.mockRestore();
  });
});

describe("ShadowService — bounded queue", () => {
  it("drops and counts observations once the queue is full", () => {
    // A never-resolving simulation keeps the queue full deterministically — no
    // reliance on timer scheduling.
    const { service, submit, recordShadowDrop } = buildHarness({
      queueMax: 2,
      concurrency: 1,
      simulate: () => new Promise<SimulateContractResult>(() => undefined),
    });

    submit();
    submit();
    submit();
    submit();

    // capacity is the queue plus the one in-flight slot a drain may hold.
    expect(service.queueStats()).toMatchObject({ depth: 2, capacity: 3, dropped: 2 });
    expect(recordShadowDrop).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
  });

  it("publishes queue depth to metrics as work is enqueued and drained", async () => {
    const { service, submit, setShadowQueueDepth } = buildHarness();

    submit();
    expect(setShadowQueueDepth).toHaveBeenLastCalledWith(1);

    await service.drain();
    expect(setShadowQueueDepth).toHaveBeenLastCalledWith(0);
  });

  it("counts in-flight simulations as depth, so a busy monitor is not a starved one", async () => {
    let release: (() => void) | undefined;
    const { service, submit } = buildHarness({
      queueMax: 10,
      concurrency: 1,
      simulate: () =>
        new Promise<SimulateContractResult>((resolve) => {
          release = () => resolve({ outcome: "ok" });
        }),
    });

    submit();
    const draining = service.drain();
    // The batch has been spliced out of the queue but the RPC has not answered.
    await Promise.resolve();
    expect(service.queueStats().depth).toBe(1);
    expect(service.queueStats().completed).toBe(0);

    release?.();
    await draining;
    expect(service.queueStats()).toMatchObject({ depth: 0, completed: 1 });
  });

  it("runs at most one drain loop at a time", async () => {
    let release: (() => void) | undefined;
    const { service, submit, simulateContract } = buildHarness({
      concurrency: 1,
      simulate: () =>
        new Promise<SimulateContractResult>((resolve) => {
          release = () => resolve({ outcome: "ok" });
        }),
    });

    submit();
    const first = service.drain();
    // A second drain must not race the first over the same queue: that would
    // reorder observations and double-count the depth gauge.
    const second = service.drain();
    release?.();
    await Promise.all([first, second]);

    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(service.queueStats().completed).toBe(1);
  });
});

describe("ShadowService — never throws into the request path", () => {
  it("survives a simulation that throws", async () => {
    const { service, submit } = buildHarness({
      simulate: async () => {
        throw new Error("socket hang up");
      },
    });

    submit();
    await expect(service.drain()).resolves.toBeUndefined();

    const report = service.report();
    expect(report.compared).toBe(1);
    expect(report.diverged).toBe(1);
    expect(report.divergences).toEqual([
      { transition: "accept", reason: "simulation_exception", count: 1 },
    ]);
  });

  it("records a skipped simulation as contract_unconfigured, not as agreement", async () => {
    const { service, submit } = buildHarness({
      simulate: async () => ({ outcome: "skipped", detail: "no source account configured" }),
    });

    submit();
    await service.drain();

    const report = service.report();
    expect(report.diverged).toBe(1);
    expect(report.divergences[0]).toMatchObject({ reason: "contract_unconfigured", count: 1 });
  });
});

describe("ShadowService — divergence classification", () => {
  it("records no divergence when the contract agrees", async () => {
    const { service, submit, recordShadowDivergence, recordShadowComparison } = buildHarness();

    submit(request({ committed: true }));
    await service.drain();

    const report = service.report();
    expect(report.compared).toBe(1);
    expect(report.diverged).toBe(0);
    expect(report.divergenceRate).toBe(0);
    expect(report.divergences).toEqual([]);
    expect(recordShadowDivergence).not.toHaveBeenCalled();
    // Both halves of the (expected, simulated) pair, not just the simulated one.
    expect(recordShadowComparison).toHaveBeenCalledWith("accept", "ok", "ok");
  });

  it("flags a contract rejection of a transition the off-chain path committed", async () => {
    const { service, submit, recordShadowComparison } = buildHarness({
      simulate: async () => ({ outcome: "rejected", detail: "contract reverted" }),
    });

    submit(request({ committed: true }));
    await service.drain();

    expect(service.report().divergences).toEqual([
      { transition: "accept", reason: "outcome_mismatch", count: 1 },
    ]);
    // The label pair is what makes the *direction* of the disagreement
    // queryable: the contract would have refused a transition we committed.
    expect(recordShadowComparison).toHaveBeenCalledWith("accept", "ok", "rejected");
  });

  it("flags a contract success for a transition the off-chain path refused", async () => {
    const { service, submit, recordShadowComparison } = buildHarness();

    submit(request({ committed: false }));
    await service.drain();

    expect(service.report().divergences).toEqual([
      { transition: "accept", reason: "outcome_mismatch", count: 1 },
    ]);
    expect(recordShadowComparison).toHaveBeenCalledWith("accept", "rejected", "ok");
  });

  it("flags a hard simulation error against a committed transition", async () => {
    const { service, submit } = buildHarness({
      simulate: async () => ({ outcome: "error", detail: "missing export" }),
    });

    submit(request({ committed: true }));
    await service.drain();

    expect(service.report().divergences).toEqual([
      { transition: "accept", reason: "simulation_error", count: 1 },
    ]);
  });

  it("does not flag a hard error against a transition the off-chain path refused", async () => {
    const { service, submit } = buildHarness({
      simulate: async () => ({ outcome: "error", detail: "missing export" }),
    });

    submit(request({ committed: false }));
    await service.drain();

    const report = service.report();
    expect(report.compared).toBe(1);
    expect(report.diverged).toBe(0);
  });

  it("attributes an unreachable RPC to us, not to the contract", async () => {
    // `unavailable` means no verdict was obtained at all. Reporting it as
    // `simulation_error` would blame the contract for our outage and poison the
    // very ratio the cutover runbook gates on.
    const { service, submit } = buildHarness({
      simulate: async () => ({ outcome: "unavailable", detail: "connection refused" }),
    });

    submit(request({ committed: true }));
    await service.drain();

    expect(service.report().divergences).toEqual([
      { transition: "accept", reason: "simulation_exception", count: 1 },
    ]);
  });

  it("records an 'unavailable' comparison outcome when there is no verdict", async () => {
    const { service, submit, recordShadowComparison } = buildHarness({
      simulate: async () => ({ outcome: "skipped", detail: "unconfigured" }),
    });

    submit(request());
    await service.drain();

    // Distinguishable in PromQL from a contract that actively said "rejected".
    expect(recordShadowComparison).toHaveBeenCalledWith("accept", "ok", "unavailable");
  });

  it("passes the configured contract, source account and args to the simulator", async () => {
    const { service, submit, simulateContract } = buildHarness({ sourceAccount: "GABC" });

    submit(request({ method: "fill_intent" }));
    await service.drain();

    expect(simulateContract).toHaveBeenCalledWith({
      contractId: SETTLEMENT_CONTRACT_ID,
      method: "fill_intent",
      args: ARGS,
      sourceAccount: "GABC",
    });
  });

  it("labels a simulation that produced no verdict as unavailable in metrics", async () => {
    const { service, submit, recordShadowComparison } = buildHarness({
      simulate: async () => {
        throw new Error("rpc unreachable");
      },
    });

    submit(request());
    await service.drain();

    expect(recordShadowComparison).toHaveBeenCalledWith("accept", "ok", "unavailable");
  });

  it("counts an observation carrying an unknown transition label as a drop", async () => {
    const { service, recordShadowDrop, recordShadowComparison } = buildHarness();

    // A label that is not one of the five can only come from a mis-wired call
    // site. It must not create a Prometheus series, and it must not vanish
    // either: it still has to appear in the totals.
    service.observe(
      request({ transition: "teleport" as unknown as ShadowObservationRequest["transition"] }),
    );
    await service.drain();

    expect(recordShadowDrop).toHaveBeenCalledTimes(1);
    expect(recordShadowComparison).not.toHaveBeenCalled();
    expect(service.report()).toMatchObject({ compared: 0, diverged: 0 });
    expect(service.queueStats().dropped).toBe(1);
  });
});

describe("ShadowService — report", () => {
  it("always lists all five transitions, even ones never observed", () => {
    const { service } = buildHarness();
    const report = service.report();

    expect(report.transitions.map((t) => t.transition)).toEqual([...SHADOW_TRANSITIONS]);
    for (const summary of report.transitions) {
      expect(summary).toMatchObject({ compared: 0, diverged: 0, divergenceRate: 0 });
    }
  });

  it("exposes lifetime totals and a per-UTC-day bucket", async () => {
    const { service, submit } = buildHarness({
      simulate: async () => ({ outcome: "rejected", detail: "reverted" }),
    });

    submit(request({ transition: "accept" }));
    submit(request({ transition: "fill" }));
    await service.drain();

    const report = service.report(7);
    expect(report.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.compared).toBe(2);
    expect(report.diverged).toBe(2);
    expect(report.divergenceRate).toBe(1);
    expect(report.daily).toHaveLength(1);
    expect(report.daily[0]).toMatchObject({ day: report.day, compared: 2, diverged: 2 });
    expect(report.daily[0].cells).toEqual(
      expect.arrayContaining([
        { transition: "accept", reason: "outcome_mismatch", count: 1 },
        { transition: "fill", reason: "outcome_mismatch", count: 1 },
      ]),
    );
  });

  it("aggregates identical divergence cells into one row", async () => {
    const { service, submit } = buildHarness({
      simulate: async () => ({ outcome: "rejected", detail: "reverted" }),
    });

    for (let i = 0; i < 5; i += 1) submit(request({ intentId: `intent-${i}` }));
    await service.drain();

    const report = service.report();
    expect(report.divergences).toEqual([
      { transition: "accept", reason: "outcome_mismatch", count: 5 },
    ]);
    expect(report.transitions[0]).toMatchObject({ compared: 5, diverged: 5, divergenceRate: 1 });
  });

  it("clamps a nonsensical or out-of-range days parameter instead of throwing", () => {
    const { service } = buildHarness();
    expect(() => service.report(0)).not.toThrow();
    expect(() => service.report(-5)).not.toThrow();
    expect(() => service.report(10_000)).not.toThrow();
    expect(() => service.report(Number.NaN)).not.toThrow();
    expect(() => service.report(1.7)).not.toThrow();
    // Clamping must still produce a usable report.
    expect(service.report(10_000).daily.length).toBeLessThanOrEqual(90);
  });

  it("reports a zero rate rather than NaN when nothing has been compared", () => {
    const { service } = buildHarness();
    const report = service.report();
    expect(Number.isNaN(report.divergenceRate)).toBe(false);
    expect(report.divergenceRate).toBe(0);
  });
});

describe("ShadowService — request-path cost (#401 acceptance criterion)", () => {
  it("keeps the whole synchronous path under the 2 ms p99 budget", async () => {
    const { service, submit } = buildHarness({ queueMax: 100_000, concurrency: 32 });

    // Warm up so the sample reflects steady state rather than first-call JIT.
    for (let i = 0; i < 200; i += 1) submit(request({ intentId: `warm-${i}` }));

    const samples: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const startedAt = process.hrtime.bigint();
      submit(request({ intentId: `bench-${i}` }));
      samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];

    // The issue's budget is a 2 ms p99 delta on the request path. The
    // synchronous work here is counter bumps, an array push and a timer
    // schedule, so this sits orders of magnitude below it; the assertion is a
    // regression tripwire, not a tight target that would make the suite flaky
    // on a loaded CI runner. The end-to-end delta, including the caller's
    // argument building, is measured in intents.service.shadow.spec.ts.
    expect(p99).toBeLessThan(2);

    // Drain so the scheduled background work is settled before the test ends.
    await service.drain();
  });
});

describe("ShadowService — lifecycle", () => {
  it("drops pending work on shutdown so nothing records against torn-down metrics", () => {
    const { service, submit } = buildHarness({
      simulate: () => new Promise<SimulateContractResult>(() => undefined),
    });

    submit();
    expect(service.queueStats().depth).toBe(1);

    service.onModuleDestroy();
    expect(service.queueStats().depth).toBe(0);
  });

  it("does not record a comparison that was in flight when the module was destroyed", async () => {
    let release: (() => void) | undefined;
    const { service, submit, recordShadowComparison } = buildHarness({
      simulate: () =>
        new Promise<SimulateContractResult>((resolve) => {
          release = () => resolve({ outcome: "ok" });
        }),
    });

    submit();
    const draining = service.drain();
    await Promise.resolve();

    service.onModuleDestroy();
    release?.();
    await draining;

    // Writing to a torn-down registry would turn a clean shutdown into an
    // unhandled rejection; the observation dies with the process instead.
    expect(recordShadowComparison).not.toHaveBeenCalled();
    expect(service.report().compared).toBe(0);
  });

  it("refuses new observations after shutdown", () => {
    const { service, submit, recordShadowDrop } = buildHarness();
    service.onModuleDestroy();

    expect(submit()).toBe(true);
    expect(recordShadowDrop).toHaveBeenCalledTimes(1);
    expect(service.queueStats().depth).toBe(0);
  });
});
