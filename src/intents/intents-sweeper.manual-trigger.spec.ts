import { Logger } from "@nestjs/common";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";
import { MetricsService } from "../metrics/metrics.service";

/**
 * Issue #269 — the manual sweep trigger (operator break-glass).
 *
 * The trigger is signal-driven (`SIGUSR2`, wired in `main.ts`), so there is no
 * HTTP surface to test for "inaccessible without a credential". What matters is
 * that invoking it runs exactly one sweep cycle and logs the invocation loudly.
 */
describe("IntentsSweeperService — manual sweep trigger (#269)", () => {
  function buildSweeper(): IntentsSweeperService {
    const intentsService = {
      getByState: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      appendAuditEntry: jest.fn(),
    } as unknown as IntentsService;
    const gateway = { broadcast: jest.fn() } as unknown as IntentsGateway;
    const solversService = { recordFailedFill: jest.fn() } as unknown as SolversService;
    const solverRegistry = {
      slashSolver: jest.fn().mockResolvedValue({ detail: "no-op" }),
    } as unknown as SolverRegistryService;
    const metricsService = { recordSweep: jest.fn() } as unknown as MetricsService;

    return new IntentsSweeperService(intentsService, gateway, solversService, solverRegistry, metricsService);
  }

  afterEach(() => jest.restoreAllMocks());

  it("runs exactly one sweep cycle and returns its result", async () => {
    const sweeper = buildSweeper();
    const sweepSpy = jest.spyOn(sweeper, "sweep");

    const result = await sweeper.triggerManualSweep("SIGUSR2");

    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      expiredCount: 0,
      slashedCount: 0,
      durationMs: expect.any(Number),
    });
  });

  it("logs the invocation loudly (source + result) for the incident timeline", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const sweeper = buildSweeper();

    await sweeper.triggerManualSweep("SIGUSR2");

    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("MANUAL SWEEP TRIGGERED"))).toBe(true);
    expect(messages.some((m) => m.includes("MANUAL SWEEP COMPLETE"))).toBe(true);
    expect(messages.every((m) => m.includes("SIGUSR2"))).toBe(true);
  });

  it("propagates and logs a failure without swallowing it", async () => {
    const sweeper = buildSweeper();
    jest.spyOn(sweeper, "sweep").mockRejectedValue(new Error("boom"));
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    await expect(sweeper.triggerManualSweep("SIGUSR2")).rejects.toThrow("boom");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MANUAL SWEEP FAILED"));
  });
});
