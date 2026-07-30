import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";

describe("IntentsSweeperService", () => {
  let intentsService: IntentsService;
  let gateway: IntentsGateway;
  let solversService: SolversService;
  let solverRegistryService: jest.Mocked<SolverRegistryService>;
  let sweeper: IntentsSweeperService;

  beforeEach(() => {
    intentsService = new IntentsService();
    gateway = { broadcast: jest.fn() } as unknown as IntentsGateway;
    solversService = new SolversService();
    solverRegistryService = {
      slashSolver: jest.fn().mockResolvedValue({
        submitted: false,
        simulated: false,
        detail: "not configured — no-op",
      }),
    } as unknown as jest.Mocked<SolverRegistryService>;

    sweeper = new IntentsSweeperService(
      intentsService,
      gateway,
      solversService,
      solverRegistryService,
    );
  });

  function makeAcceptedIntent(deadline: number, solver = "SOLVER_ALPHA") {
    const intent = intentsService.create({
      user: "GTEST...0000",
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: deadline + 10_000, // create as open with a far-future deadline first
    });
    intentsService.update(intent.intentId, { state: "accepted", solver, deadline });
    return intent.intentId;
  }

  it("expires open intents past their deadline (existing behavior preserved)", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const intent = intentsService.create({
      user: "GTEST...0000",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: past,
    });

    await sweeper.sweep();

    expect(intentsService.get(intent.intentId)?.state).toBe("expired");
    expect(gateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "intent_expired", intentId: intent.intentId }),
    );
  });

  it("slashes an accepted intent whose fill deadline has passed", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const intentId = makeAcceptedIntent(past, "SOLVER_ALPHA");

    await sweeper.sweep();

    const updated = intentsService.get(intentId);
    expect(updated?.state).toBe("slashed");
    expect(updated?.slashedAt).toBeDefined();
    expect(updated?.slashReason).toBeTruthy();

    expect(gateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "intent_slashed", intentId, solver: "SOLVER_ALPHA" }),
    );
    expect(solverRegistryService.slashSolver).toHaveBeenCalledWith(
      expect.objectContaining({ solverAddress: "SOLVER_ALPHA", intentId }),
    );
  });

  it("bumps the solver's fillsFailed counter on a slash", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const before = solversService.get("SOLVER_ALPHA")?.fillsFailed ?? 0;
    const intentId = makeAcceptedIntent(past, "SOLVER_ALPHA");

    await sweeper.sweep();

    expect(solversService.get("SOLVER_ALPHA")?.fillsFailed).toBe(before + 1);
    expect(intentsService.get(intentId)?.state).toBe("slashed");
  });

  it("does not touch accepted intents still within their fill window", async () => {
    const future = Math.floor(Date.now() / 1000) + 300;
    const intentId = makeAcceptedIntent(future, "SOLVER_ALPHA");

    await sweeper.sweep();

    expect(intentsService.get(intentId)?.state).toBe("accepted");
    expect(solverRegistryService.slashSolver).not.toHaveBeenCalled();
  });

  it("does not throw if an accepted intent somehow has no solver on record", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const intent = intentsService.create({
      user: "GTEST...0000",
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: past + 10_000,
    });
    intentsService.update(intent.intentId, { state: "accepted", deadline: past });

    await expect(sweeper.sweep()).resolves.not.toThrow();
    expect(intentsService.get(intent.intentId)?.state).toBe("slashed");
    expect(solverRegistryService.slashSolver).not.toHaveBeenCalled();
  });
});
