import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentDeadlineScheduler, delayUntil } from "./intents-deadline.jobs";
import { IntentsGateway } from "./intents.gateway";
import { JobsService } from "../jobs/jobs.service";
import { AppConfig } from "../config/configuration";
import { InMemoryIntentsRepository } from "./intents.repository";
import { PrismaService } from "../prisma/prisma.service";
import { ProtocolParamsService } from "../governance/params.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { MetricsService } from "../metrics/metrics.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";
import { LeaderElectionService } from "../common/leader-election";

function jobsConfig(): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => {
      if (key === "jobs") return { driver: "memory", shutdownTimeoutMs: 1000 };
      if (key === "processRole") return "all";
      if (key === "safetySweepIntervalMs") return 300_000;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

function buildIntents(scheduler: IntentDeadlineScheduler): IntentsService {
  const repo = new InMemoryIntentsRepository();
  (repo as unknown as { store: Map<string, unknown> }).store.clear();
  const protocolParams = {
    snapshotForChain: jest.fn().mockReturnValue({
      version: 0,
      feeBps: 30,
      deadlineSeconds: 1800,
      fillWindowSeconds: 600,
      capturedAt: new Date().toISOString(),
    }),
  } as unknown as ProtocolParamsService;
  return new IntentsService(
    repo,
    { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService<AppConfig, true>,
    {} as StellarTxService,
    { intentAuditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService,
    protocolParams,
    undefined,
    undefined,
    undefined,
    scheduler,
  );
}

describe("deadline jobs", () => {
  let jobs: JobsService;
  let sweeper: IntentsSweeperService;
  let intents: IntentsService;
  const recordSafetyCatch = jest.fn();

  beforeEach(() => {
    jobs = new JobsService(jobsConfig());
    const scheduler = new IntentDeadlineScheduler(jobs);
    intents = buildIntents(scheduler);
    const metrics = { recordSweep: jest.fn(), recordSafetyCatch } as unknown as MetricsService;
    sweeper = new IntentsSweeperService(
      intents,
      { broadcast: jest.fn().mockResolvedValue(undefined) } as unknown as IntentsGateway,
      {} as SolversService,
      { slashSolver: jest.fn().mockResolvedValue({ detail: "no-op" }) } as unknown as SolverRegistryService,
      metrics,
      { evaluateTarget: jest.fn().mockReturnValue({ paused: false, matched: null, matchedChain: [] }) } as unknown as KillSwitchService,
      { registerWorker: jest.fn() } as unknown as LeaderElectionService,
      jobsConfig(),
      jobs,
    );
    sweeper.onModuleInit();
    recordSafetyCatch.mockClear();
  });

  afterEach(async () => {
    await jobs.onApplicationShutdown();
  });

  it("expires an open intent within 2s of its deadline", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 1;
    const intent = await intents.create({
      user: "GTEST",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "1",
      deadline,
    });

    const started = Date.now();
    let state = (await intents.get(intent.intentId))?.state;
    while (state !== "expired" && Date.now() - started < 2500) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (await intents.get(intent.intentId))?.state;
    }
    expect(state).toBe("expired");
    expect(Date.now() - deadline * 1000).toBeLessThan(2000);
  });

  it("ignores a stale expire job when the deadline was moved", async () => {
    const past = Math.floor(Date.now() / 1000) - 5;
    const intent = await intents.create({
      user: "GTEST",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "1",
      deadline: past + 10_000,
    });
    await intents.update(intent.intentId, { deadline: past });

    await sweeper.handleExpireJob({ intentId: intent.intentId, deadline: past + 10_000 });
    expect((await intents.get(intent.intentId))?.state).toBe("open");

    await sweeper.handleExpireJob({ intentId: intent.intentId, deadline: past });
    expect((await intents.get(intent.intentId))?.state).toBe("expired");
    await sweeper.handleExpireJob({ intentId: intent.intentId, deadline: past });
    expect((await intents.get(intent.intentId))?.state).toBe("expired");
  });

  it("counts intents the safety sweep still has to settle", async () => {
    await sweeper.sweep({ safety: true });
    expect(recordSafetyCatch).toHaveBeenCalledWith(0);

    const past = Math.floor(Date.now() / 1000) - 5;
    const late = await intents.create({
      user: "GTEST2",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "1",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    await intents.update(late.intentId, { deadline: past });
    recordSafetyCatch.mockClear();
    await sweeper.sweep({ safety: true });
    expect(recordSafetyCatch).toHaveBeenCalledWith(1);
  });

  it("delayUntil is zero once the deadline has passed", () => {
    expect(delayUntil(1, 5_000)).toBe(0);
    expect(delayUntil(10, 1_000)).toBe(9_000);
  });
});
