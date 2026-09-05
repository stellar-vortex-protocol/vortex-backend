import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { IntentsSweeperService } from "./intents-sweeper.service";
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
  return new IntentsService(repo, configService, stellarTxService, prismaService);
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

    sweeper = new IntentsSweeperService(
      intentsService,
      gateway,
      solversService,
      solverRegistryService,
      metricsService as unknown as MetricsService,
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
});
