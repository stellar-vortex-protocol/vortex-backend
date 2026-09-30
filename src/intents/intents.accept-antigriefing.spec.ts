import { Keypair } from "@stellar/stellar-sdk";
import { IntentsController } from "./intents.controller";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import {
  AntiGriefingException,
  AntiGriefingService,
} from "../solvers/anti-griefing.service";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { Intent } from "./intents.types";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { buildAcceptMessage, buildFillMessage } from "../common/stellar-signature";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";

/**
 * Issue #453 — the anti-griefing policy engine is evaluated in the accept
 * critical section. These tests pin *where*: the refusal must happen before
 * the atomic `acceptIfOpen` write, so a solver that is out of favour cannot
 * mutate intent state.
 */
describe("IntentsController.accept — anti-griefing enforcement (#453)", () => {
  const keypair = Keypair.random();
  const solver = keypair.publicKey();
  const intentId = "intent-grief-test";

  type IntentsServiceMock = {
    get: jest.Mock;
    getAcceptedCountBySolver: jest.Mock;
    acceptIfOpen: jest.Mock;
    fillIfAccepted: jest.Mock;
    appendAuditEntry: jest.Mock;
    expireIfOpen: jest.Mock;
  };
  type SolversServiceMock = {
    get: jest.Mock;
    isSuspended: jest.Mock;
    recordSuccessfulFill: jest.Mock;
  };

  let intentsService: IntentsServiceMock;
  let solversService: SolversServiceMock;
  let gateway: { broadcast: jest.Mock };
  let killSwitch: { evaluateTarget: jest.Mock };
  let antiGriefing: { assertCanAccept: jest.Mock; recordOutcome: jest.Mock };
  let controller: IntentsController;
  let acceptDto: AcceptIntentDto;

  function openIntent(): Intent {
    return {
      intentId,
      user: "GUSER000000000000000000000000000000000000000000000000",
      srcChain: "ethereum",
      srcToken: {
        address: "0xabc",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        chain: "ethereum",
      },
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      srcAmount: "1000000",
      minDstAmount: "990000",
      state: "open",
      // Comfortably in the future relative to Date.now().
      deadline: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
    } as unknown as Intent;
  }

  function sign(message: string): string {
    return keypair.sign(Buffer.from(message)).toString("base64");
  }

  beforeEach(() => {
    intentsService = {
      get: jest.fn().mockResolvedValue(openIntent()),
      getAcceptedCountBySolver: jest.fn().mockResolvedValue(3),
      acceptIfOpen: jest
        .fn()
        .mockImplementation(async () => ({ ...openIntent(), state: "accepted" })),
      fillIfAccepted: jest.fn().mockResolvedValue(undefined),
      appendAuditEntry: jest.fn(),
      expireIfOpen: jest.fn().mockResolvedValue(false),
    };
    solversService = {
      get: jest.fn().mockResolvedValue({ address: solver, isActive: true, bondAmount: "100" }),
      isSuspended: jest.fn().mockReturnValue(false),
      recordSuccessfulFill: jest.fn().mockResolvedValue(null),
    };
    gateway = { broadcast: jest.fn().mockResolvedValue(undefined) };
    killSwitch = {
      evaluateTarget: jest.fn().mockReturnValue({ paused: false, matched: null, matchedChain: [] }),
    };
    antiGriefing = {
      assertCanAccept: jest.fn().mockResolvedValue(undefined),
      recordOutcome: jest.fn(),
    };

    controller = new IntentsController(
      intentsService as unknown as IntentsService,
      solversService as unknown as SolversService,
      gateway as unknown as IntentsGateway,
      {} as TokensService,
      {} as RoutingService,
      killSwitch as unknown as KillSwitchService,
      antiGriefing as unknown as AntiGriefingService,
      { get: jest.fn().mockReturnValue([]) } as unknown as ConfigService<AppConfig, true>,
    );

    acceptDto = {
      solver,
      signature: sign(buildAcceptMessage(intentId, solver)),
    };
  });

  it("evaluates the policy engine with a lazy, real concurrency count", async () => {
    await controller.accept(intentId, acceptDto);

    expect(antiGriefing.assertCanAccept).toHaveBeenCalledTimes(1);
    const [addr, ctx] = antiGriefing.assertCanAccept.mock.calls[0] as [
      string,
      { intentId: string; openAccepts: () => Promise<number> },
    ];
    expect(addr).toBe(solver);
    expect(ctx.intentId).toBe(intentId);

    // The cap must be computed from atomic intent state — and only on demand,
    // so an unpunished solver never pays for the scan.
    expect(intentsService.getAcceptedCountBySolver).not.toHaveBeenCalled();
    await expect(ctx.openAccepts()).resolves.toBe(3);
    expect(intentsService.getAcceptedCountBySolver).toHaveBeenCalledWith(solver);
  });

  it("never mutates intent state when the policy engine refuses", async () => {
    const refusal = new AntiGriefingException({
      code: "ANTIGRIEFING_COOLDOWN",
      error: "Solver is cooling down after repeated accept-without-fill behaviour",
      status: 429,
      retryAfterSeconds: 300,
      details: { solver, intentId },
    });
    antiGriefing.assertCanAccept.mockRejectedValue(refusal);

    await expect(controller.accept(intentId, acceptDto)).rejects.toBe(refusal);

    expect(intentsService.acceptIfOpen).not.toHaveBeenCalled();
    expect(intentsService.appendAuditEntry).not.toHaveBeenCalled();
    expect(gateway.broadcast).not.toHaveBeenCalled();
  });

  it("still accepts when the policy engine admits the solver", async () => {
    const updated = await controller.accept(intentId, acceptDto);

    expect(intentsService.acceptIfOpen).toHaveBeenCalledWith(intentId, solver, expect.any(Number));
    expect(intentsService.appendAuditEntry).toHaveBeenCalledWith(
      intentId,
      "accepted",
      solver,
      "solver accepted",
      expect.any(Object),
    );
    expect(gateway.broadcast).toHaveBeenCalledWith({
      type: "intent_accepted",
      intentId,
      solver,
    });
    expect(updated.state).toBe("accepted");
  });

  it("runs after the existing guards so unrelated refusals keep their own errors", async () => {
    intentsService.get.mockResolvedValue(undefined);

    await expect(controller.accept(intentId, acceptDto)).rejects.toMatchObject({ status: 404 });
    expect(antiGriefing.assertCanAccept).not.toHaveBeenCalled();
  });

  it("records a successful fill against the solver's rolling window", async () => {
    const intent = openIntent();
    intentsService.get.mockResolvedValue(intent);
    intentsService.fillIfAccepted.mockResolvedValue({ ...intent, state: "filled" });
    solversService.get.mockResolvedValue({
      address: solver,
      isActive: true,
      bondAmount: "100",
      supportedChains: ["ethereum"],
      supportedTokens: ["USDC"],
    });

    const fillDto: FillIntentDto = {
      solver,
      fillAmount: "1000000",
      txHash: "0xdeadbeef",
      signature: sign(buildFillMessage(intentId, solver)),
    };
    await controller.fill(intentId, fillDto);

    expect(antiGriefing.recordOutcome).toHaveBeenCalledWith(solver, {
      intentId,
      chain: "ethereum",
      outcome: "filled",
    });
  });
});
