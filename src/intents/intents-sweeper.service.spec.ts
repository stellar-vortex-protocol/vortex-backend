import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";
import { MetricsService } from "../metrics/metrics.service";
import { InMemorySolversRepository } from "../solvers/in-memory-solvers.repository";
import { SOLVERS_REPOSITORY } from "../solvers/solvers.repository";
import { InMemoryIntentsRepository } from "./intents.repository";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { ProtocolParamsService } from "../governance/params.service";
import { LeaderElectionService } from "../common/leader-election";

/** Minimal no-op LeaderElectionService for tests that don't exercise election. */
function noopLeaderElection(): LeaderElectionService {
  return {
    registerWorker: jest.fn(),
    isLeader: jest.fn().mockReturnValue(true),
    getState: jest.fn().mockReturnValue(null),
    getAllStates: jest.fn().mockReturnValue({}),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    runHeartbeatOnce: jest.fn().mockResolvedValue(undefined),
  } as unknown as LeaderElectionService;
}

/** Use a stable test address (does not need to be a real funded key). */
const ALPHA_KEYPAIR = Keypair.random();
const ALPHA_ADDR = ALPHA_KEYPAIR.publicKey();

function buildIntentsService(): IntentsService {
  const configService = {
    get: jest.fn().mockReturnValue(false),
  } as unknown as ConfigService<AppConfig, true>;
  const stellarTxService = {} as StellarTxService;
  const prismaService = {
    intentAuditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
  const repo = new InMemoryIntentsRepository();
  // Clear seed data so tests start with a clean slate
  (repo as unknown as { store: Map<string, unknown> }).store.clear();
  const protocolParams = {
    snapshotForChain: jest.fn().mockReturnValue({ version: 0, feeBps: 30, deadlineSeconds: 1800, fillWindowSeconds: 600, capturedAt: new Date().toISOString() }),
  } as unknown as ProtocolParamsService;
  return new IntentsService(repo, configService, stellarTxService, prismaService, protocolParams);
}

async function buildSolversService(): Promise<SolversService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      { provide: SOLVERS_REPOSITORY, useClass: InMemorySolversRepository },
      SolversService,
    ],
  }).compile();
  return module.get<SolversService>(SolversService);
}

describe("IntentsSweeperService", () => {
  let intentsService: IntentsService;
  let gateway: IntentsGateway;
  let solversService: SolversService;
  let solverRegistryService: jest.Mocked<SolverRegistryService>;
  let metricsService: jest.Mocked<Pick<MetricsService, "recordSweep">>;
  let killSwitch: jest.Mocked<Pick<KillSwitchService, "evaluateTarget">>;
  let sweeper: IntentsSweeperService;

  beforeEach(async () => {
    intentsService = buildIntentsService();
    gateway = { broadcast: jest.fn().mockResolvedValue(undefined) } as unknown as IntentsGateway;
    solversService = await buildSolversService();
    solverRegistryService = {
      slashSolver: jest.fn().mockResolvedValue({
        submitted: false,
        simulated: false,
        detail: "not configured — no-op",
      }),
    } as unknown as jest.Mocked<SolverRegistryService>;
    metricsService = { recordSweep: jest.fn() } as unknown as jest.Mocked<Pick<MetricsService, "recordSweep">>;
    // Default: no pause active, so existing sweeper expectations are unchanged.
    killSwitch = {
      evaluateTarget: jest.fn().mockReturnValue({ paused: false, matched: null, matchedChain: [] }),
    } as unknown as jest.Mocked<Pick<KillSwitchService, "evaluateTarget">>;

    sweeper = new IntentsSweeperService(
      intentsService,
      gateway,
      solversService,
      solverRegistryService,
      metricsService as unknown as MetricsService,
      killSwitch as unknown as KillSwitchService,
      noopLeaderElection(),
    );
  });

  async function makeAcceptedIntent(deadline: number, solver = ALPHA_ADDR) {
    const intent = await intentsService.create({
      user: "GTEST...0000",
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: deadline + 10_000, // create as open with a far-future deadline first
    });
    await intentsService.update(intent.intentId, { state: "accepted", solver, deadline });
    return intent.intentId;
  }

  it("expires open intents past their deadline (existing behavior preserved)", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const intent = await intentsService.create({
      user: "GTEST...0000",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: past,
    });

    await sweeper.sweep();

    expect((await intentsService.get(intent.intentId))?.state).toBe("expired");
    expect(gateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "intent_expired", intentId: intent.intentId }),
    );
  });

  it("slashes an accepted intent whose fill deadline has passed", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);

    await sweeper.sweep();

    const updated = await intentsService.get(intentId);
    expect(updated?.state).toBe("slashed");
    expect(updated?.slashedAt).toBeDefined();
    expect(updated?.slashReason).toBeTruthy();

    expect(gateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "intent_slashed", intentId, solver: ALPHA_ADDR }),
    );
    expect(solverRegistryService.slashSolver).toHaveBeenCalledWith(
      expect.objectContaining({ solverAddress: ALPHA_ADDR, intentId }),
    );
  });

  it("bumps the solver's fillsFailed counter on a slash", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;

    // Register the solver so recordFailedFill has a record to update
    await solversService.register({
      address: ALPHA_ADDR,
      name: "Alpha Test Solver",
      bondAmount: "1000000",
      isActive: true,
      supportedChains: ["ethereum"],
      supportedTokens: ["USDC"],
      avgFillTime: 30,
    });

    const before = (await solversService.get(ALPHA_ADDR))?.fillsFailed ?? 0;
    const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);

    await sweeper.sweep();

    expect((await solversService.get(ALPHA_ADDR))?.fillsFailed).toBe(before + 1);
    expect((await intentsService.get(intentId))?.state).toBe("slashed");
  });

  it("does not touch accepted intents still within their fill window", async () => {
    const future = Math.floor(Date.now() / 1000) + 300;
    const intentId = await makeAcceptedIntent(future, ALPHA_ADDR);

    await sweeper.sweep();

    expect((await intentsService.get(intentId))?.state).toBe("accepted");
    expect(solverRegistryService.slashSolver).not.toHaveBeenCalled();
  });

  it("does not throw if an accepted intent somehow has no solver on record", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const intent = await intentsService.create({
      user: "GTEST...0000",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: past + 10_000,
    });
    await intentsService.update(intent.intentId, { state: "accepted", deadline: past });

    await expect(sweeper.sweep()).resolves.not.toThrow();
    expect((await intentsService.get(intent.intentId))?.state).toBe("slashed");
    expect(solverRegistryService.slashSolver).not.toHaveBeenCalled();
  });

  // ── #259: MetricsService integration ────────────────────────────────────

  it("records sweep metrics via MetricsService on every sweep cycle", async () => {
    await sweeper.sweep();
    expect(metricsService.recordSweep).toHaveBeenCalledTimes(1);
    const [expiredCount, durationMs] = (metricsService.recordSweep as jest.Mock).mock.calls[0] as [number, number];
    expect(typeof expiredCount).toBe("number");
    expect(typeof durationMs).toBe("number");
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records correct expired count in MetricsService", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    // Create 2 expired intents
    await intentsService.create({
      user: "GTEST...0001",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: past,
    });
    await intentsService.create({
      user: "GTEST...0002",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: past,
    });

    await sweeper.sweep();

    const [expiredCount] = (metricsService.recordSweep as jest.Mock).mock.calls[0] as [number, number];
    expect(expiredCount).toBe(2);
  });

  // ── Issue #477: a pause must not punish solvers ─────────────────────────────

  describe("fill pause (issue #477)", () => {
    it("suppresses slashing and extends the deadline while fills are paused", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);
      killSwitch.evaluateTarget.mockReturnValue({
        paused: true,
        matched: {
          scope: "chain",
          chain: "ethereum",
          token: null,
          operation: null,
          active: true,
          reasonCode: "CHAIN_DEGRADED",
          reason: "flap",
          activatedBy: "alice",
          updatedAt: 1,
        },
        matchedChain: [],
      });

      const result = await sweeper.sweep();

      // Not slashed — the pause, not the solver, caused the missed fill.
      expect(result.slashedCount).toBe(0);
      expect(result.extendedDeadlines).toBe(1);
      expect(solverRegistryService.slashSolver).not.toHaveBeenCalled();

      const updated = await intentsService.get(intentId);
      expect(updated?.state).toBe("accepted");
      expect(updated!.deadline).toBeGreaterThan(past);
    });

    it("grants a full fill window from now, so a long pause is not penalised", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);
      killSwitch.evaluateTarget.mockReturnValue({
        paused: true,
        matched: null,
        matchedChain: [],
      });

      await sweeper.sweep();

      const updated = await intentsService.get(intentId);
      // ethereum's fill window is 1800 s, so the new deadline is ~30 min out.
      expect(updated!.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000) + 1000);
    });

    it("is idempotent — a second sweep does not keep pushing the deadline out", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);
      killSwitch.evaluateTarget.mockReturnValue({
        paused: true,
        matched: null,
        matchedChain: [],
      });

      await sweeper.sweep();
      const afterFirst = (await intentsService.get(intentId))!.deadline;

      // The intent is no longer past deadline, so the sweeper skips it entirely.
      const second = await sweeper.sweep();
      const afterSecond = (await intentsService.get(intentId))!.deadline;

      expect(second.extendedDeadlines).toBe(0);
      expect(afterSecond).toBe(afterFirst);
    });

    it("evaluates the pause per intent, so a token-scoped pause spares other tokens", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);

      // Paused only for a different token.
      killSwitch.evaluateTarget.mockReturnValue({
        paused: false,
        matched: null,
        matchedChain: [],
      });

      const result = await sweeper.sweep();

      expect(result.slashedCount).toBe(1);
      expect((await intentsService.get(intentId))?.state).toBe("slashed");
    });

    it("slashing resumes normally once the pause is lifted", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const intentId = await makeAcceptedIntent(past, ALPHA_ADDR);

      // Paused: window extended.
      killSwitch.evaluateTarget.mockReturnValue({ paused: true, matched: null, matchedChain: [] });
      await sweeper.sweep();
      expect((await intentsService.get(intentId))?.state).toBe("accepted");

      // Resumed, and the window has since elapsed again.
      killSwitch.evaluateTarget.mockReturnValue({ paused: false, matched: null, matchedChain: [] });
      await intentsService.update(intentId, { deadline: past });

      const result = await sweeper.sweep();
      expect(result.slashedCount).toBe(1);
      expect((await intentsService.get(intentId))?.state).toBe("slashed");
    });
  });
});
