import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { KillSwitchActiveException } from "../killswitch/killswitch.guard";
import { MetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProtocolParamsService } from "../governance/params.service";
import { InMemorySolversRepository } from "../solvers/in-memory-solvers.repository";
import { InMemoryPendingSlashesRepository } from "../solvers/pending-slashes.repository";
import { SolversService } from "../solvers/solvers.service";
import { FillVerifierService } from "../soroban/fill-verifier.service";
import { SlashResult, SolverRegistryService } from "../soroban/solver-registry.service";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { TxConfirmationService } from "../soroban/tx-confirmation.service";
import { IntentsGateway } from "./intents.gateway";
import { InMemoryIntentsRepository } from "./intents.repository";
import { IntentsService } from "./intents.service";
import { SlashingPipelineService } from "./slashing-pipeline.service";

const WINDOW = 600;
const SKEW = 30;
const MAX_ATTEMPTS = 3;
const T0 = 1_900_000_000; // detection time, unix seconds
const at = (seconds: number) => new Date((T0 + seconds) * 1000);

const ok = (overrides: Partial<SlashResult> = {}): SlashResult => ({
  submitted: true,
  simulated: true,
  dryRun: false,
  failed: false,
  txHash: "slash-tx",
  detail: "submitted",
  ...overrides,
});

describe("SlashingPipelineService (#397)", () => {
  let slashes: InMemoryPendingSlashesRepository;
  let intents: IntentsService;
  let solvers: SolversService;
  let gateway: { broadcast: jest.Mock };
  let registry: { slashSolver: jest.Mock<Promise<SlashResult>> };
  let verifier: { findLandedFill: jest.Mock; verifyFillProof: jest.Mock };
  let confirmation: { check: jest.Mock };
  let metrics: { recordSlashTransition: jest.Mock };
  let pipeline: SlashingPipelineService;
  let solver: string;
  let intentId: string;
  let fillDeadline: number;

  async function acceptedThenSlashedIntent(): Promise<string> {
    const created = await intents.create({
      user: Keypair.random().publicKey(),
      srcChain: "stellar",
      srcToken: { address: "native", symbol: "XLM", name: "Stellar Lumens", decimals: 7, chain: "stellar" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: T0 + 10_000,
    });
    await intents.update(created.intentId, { state: "accepted", solver, deadline: fillDeadline });
    await intents.slashIfAccepted(created.intentId, { slashedAt: T0, slashReason: "missed" });
    await solvers.recordFailedFill(solver, created.intentId);
    return created.intentId;
  }

  const detect = () =>
    pipeline.detect({ intentId, solverAddress: solver, reason: "missed fill", fillDeadline, detectedAt: T0 });
  const state = async () => (await slashes.findByIntent(intentId))?.state;
  const fillsFailed = async () => (await solvers.get(solver))?.fillsFailed;

  beforeEach(async () => {
    slashes = new InMemoryPendingSlashesRepository();
    const repo = new InMemoryIntentsRepository();
    (repo as unknown as { store: Map<string, unknown> }).store.clear();
    intents = new IntentsService(
      repo,
      { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService<AppConfig, true>,
      {} as StellarTxService,
      { intentAuditLog: { create: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService,
      undefined,
      undefined,
      {
        snapshotForChain: jest.fn().mockReturnValue({ version: 0, feeBps: 30, deadlineSeconds: 1800, fillWindowSeconds: 600 }),
      } as unknown as ProtocolParamsService,
    );
    solvers = new SolversService(new InMemorySolversRepository());
    solver = Keypair.random().publicKey();
    await solvers.register({
      address: solver,
      name: "Alpha",
      bondAmount: "1000000",
      isActive: true,
      supportedChains: ["stellar"],
      supportedTokens: ["XLM"],
      avgFillTime: 30,
    });
    gateway = { broadcast: jest.fn().mockResolvedValue(undefined) };
    registry = { slashSolver: jest.fn().mockResolvedValue(ok()) };
    verifier = { findLandedFill: jest.fn().mockResolvedValue(null), verifyFillProof: jest.fn() };
    confirmation = { check: jest.fn().mockResolvedValue({ status: "not_found" }) };
    metrics = { recordSlashTransition: jest.fn() };
    const slashing: AppConfig["slashing"] = {
      challengeWindowSeconds: WINDOW,
      clockSkewToleranceSeconds: SKEW,
      maxSubmitAttempts: MAX_ATTEMPTS,
    };
    pipeline = new SlashingPipelineService(
      slashes,
      intents,
      gateway as unknown as IntentsGateway,
      solvers,
      registry as unknown as SolverRegistryService,
      verifier as unknown as FillVerifierService,
      confirmation as unknown as TxConfirmationService,
      metrics as unknown as MetricsService,
      { get: () => slashing } as unknown as ConfigService<AppConfig, true>,
    );
    fillDeadline = T0 - 5;
    intentId = await acceptedThenSlashedIntent();
  });

  afterEach(() => {
    pipeline.onModuleDestroy();
  });

  describe("detection", () => {
    it("records the slash and opens a challenge window ending detectedAt + window", async () => {
      const slash = await detect();
      expect(slash).toMatchObject({ state: "challenge_window", solverAddress: solver, fillDeadline });
      expect(slash.challengeEndsAt).toEqual(at(WINDOW));
      expect(metrics.recordSlashTransition).toHaveBeenCalledWith("detected");
      expect(metrics.recordSlashTransition).toHaveBeenCalledWith("challenge_window");
      expect(intents.getAuditLog(intentId).at(-1)?.reason).toMatch(/challenge window open/);
    });

    it("is exactly-once per intent: re-detection is a no-op", async () => {
      await detect();
      const again = await detect();
      expect(again.state).toBe("challenge_window");
      expect(metrics.recordSlashTransition.mock.calls.filter(([s]) => s === "detected")).toHaveLength(1);

      await pipeline.processDue(at(WINDOW + 1));
      await detect();
      await pipeline.processDue(at(WINDOW + 2));
      expect(registry.slashSolver).toHaveBeenCalledTimes(1);
    });

    it("resumes a row left in `detected` by a crash", async () => {
      await slashes.createIfAbsent({
        intentId,
        solverAddress: solver,
        reason: "r",
        fillDeadline,
        detectedAt: at(0),
        challengeEndsAt: at(WINDOW),
      });
      await pipeline.processDue(at(1));
      expect(await state()).toBe("challenge_window");
    });
  });

  describe("challenge window", () => {
    it("does not submit before the window ends", async () => {
      await detect();
      await pipeline.processDue(at(WINDOW - 1));
      expect(registry.slashSolver).not.toHaveBeenCalled();
      expect(await state()).toBe("challenge_window");
    });

    it("re-verifies, then submits once the window is over", async () => {
      await detect();
      await pipeline.processDue(at(WINDOW));
      expect(verifier.findLandedFill).toHaveBeenCalledWith(intentId, fillDeadline, fillDeadline + SKEW, T0 + WINDOW);
      expect(registry.slashSolver).toHaveBeenCalledWith({ solverAddress: solver, intentId, reason: "missed fill" });
      expect(await slashes.findByIntent(intentId)).toMatchObject({
        state: "submitted",
        txHash: "slash-tx",
        simulated: false,
      });
      expect(metrics.recordSlashTransition).toHaveBeenCalledWith("submitted", "broadcast");
    });

    it("dry-run / gated submit is recorded as simulated and not polled for confirmation", async () => {
      registry.slashSolver.mockResolvedValueOnce(ok({ submitted: false, dryRun: true, txHash: undefined }));
      await detect();
      await pipeline.processDue(at(WINDOW));
      expect(await slashes.findByIntent(intentId)).toMatchObject({ state: "submitted", simulated: true });
      await pipeline.processDue(at(WINDOW + 3600));
      expect(confirmation.check).not.toHaveBeenCalled();
    });
  });

  describe("scenario: late fill", () => {
    it("cancels when re-verification finds a fill that landed in time, and compensates", async () => {
      await detect();
      verifier.findLandedFill.mockResolvedValueOnce({ txHash: "fill-tx", ledger: 9, closedAt: fillDeadline + SKEW });

      await pipeline.processDue(at(WINDOW));

      expect(registry.slashSolver).not.toHaveBeenCalled();
      expect(await slashes.findByIntent(intentId)).toMatchObject({
        state: "cancelled",
        cancelReason: "fill_landed",
        cancelledBy: "system",
        fillTxHash: "fill-tx",
      });
      expect(await fillsFailed()).toBe(0);
      expect((await intents.get(intentId))?.state).toBe("filled");
      expect((await intents.get(intentId))?.txHash).toBe("fill-tx");
      expect(gateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "intent_slash_cancelled", intentId, reason: "fill_landed" }),
      );
      expect(metrics.recordSlashTransition).toHaveBeenCalledWith("cancelled", "fill_landed");
    });

    it("solver fill-proof during the window cancels the slash", async () => {
      await detect();
      verifier.verifyFillProof.mockResolvedValueOnce({ valid: true, fill: { txHash: "f", ledger: 1, closedAt: 1 } });

      const cancelled = await pipeline.cancelByFillProof(intentId, solver, "f");

      expect(verifier.verifyFillProof).toHaveBeenCalledWith("f", intentId, fillDeadline + SKEW);
      expect(cancelled).toMatchObject({ state: "cancelled", cancelledBy: solver, fillTxHash: "f" });
      expect(await fillsFailed()).toBe(0);
      await pipeline.processDue(at(WINDOW + 1));
      expect(registry.slashSolver).not.toHaveBeenCalled();
    });

    it("rejects fill-proofs that do not verify, come from another solver, or arrive after the window", async () => {
      await expect(pipeline.cancelByFillProof("nope", solver, "f")).rejects.toBeInstanceOf(NotFoundException);
      await detect();
      await expect(pipeline.cancelByFillProof(intentId, Keypair.random().publicKey(), "f")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      verifier.verifyFillProof.mockResolvedValueOnce({ valid: false, reason: "closed too late" });
      await expect(pipeline.cancelByFillProof(intentId, solver, "f")).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      await pipeline.processDue(at(WINDOW));
      await expect(pipeline.cancelByFillProof(intentId, solver, "f")).rejects.toBeInstanceOf(ConflictException);
    });

    it("reports a conflict if the slash moved on while the proof was being verified", async () => {
      await detect();
      verifier.verifyFillProof.mockImplementationOnce(async () => {
        await slashes.transition(intentId, ["challenge_window"], { state: "submitted" });
        return { valid: true, fill: { txHash: "f", ledger: 1, closedAt: 1 } };
      });
      await expect(pipeline.cancelByFillProof(intentId, solver, "f")).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("scenario: admin cancel", () => {
    it("cancels during the window, compensates, and expires the intent", async () => {
      await detect();
      const cancelled = await pipeline.cancelByAdmin(intentId, "ops@vortex", "event delayed, fill confirmed manually");
      expect(cancelled).toMatchObject({
        state: "cancelled",
        cancelledBy: "ops@vortex",
        cancelReason: "admin: event delayed, fill confirmed manually",
      });
      expect(await fillsFailed()).toBe(0);
      expect((await intents.get(intentId))?.state).toBe("expired");
      await pipeline.processDue(at(WINDOW + 1));
      expect(registry.slashSolver).not.toHaveBeenCalled();
    });

    it("compensates at most once", async () => {
      await detect();
      await pipeline.cancelByAdmin(intentId, "ops", "first cancel");
      await expect(pipeline.cancelByAdmin(intentId, "ops", "second cancel")).rejects.toBeInstanceOf(ConflictException);
      expect(await fillsFailed()).toBe(0);
    });

    it("refuses once submitted, while a worker holds the lease, or for an unknown intent", async () => {
      await expect(pipeline.cancelByAdmin("unknown", "ops", "why not")).rejects.toBeInstanceOf(NotFoundException);

      await detect();
      await slashes.claim(intentId, new Date(), new Date(Date.now() + 60_000));
      await expect(pipeline.cancelByAdmin(intentId, "ops", "mid submit")).rejects.toThrow(/submission in progress/);

      await slashes.transition(intentId, ["challenge_window"], { state: "submitted" });
      await expect(pipeline.cancelByAdmin(intentId, "ops", "too late")).rejects.toThrow(/state=submitted/);
    });
  });

  describe("scenario: RPC failure during submit", () => {
    it("retries with backoff and does not submit blind when re-verification fails", async () => {
      await detect();
      verifier.findLandedFill.mockRejectedValueOnce(new Error("RPC timeout"));
      await pipeline.processDue(at(WINDOW));
      expect(registry.slashSolver).not.toHaveBeenCalled();
      const row = await slashes.findByIntent(intentId);
      expect(row).toMatchObject({ state: "challenge_window", attempts: 1, lastError: expect.stringContaining("RPC timeout") });
      expect(row!.nextAttemptAt).toEqual(new Date(at(WINDOW).getTime() + 5_000));

      await pipeline.processDue(at(WINDOW + 1));
      expect(registry.slashSolver).not.toHaveBeenCalled(); // still backing off
      await pipeline.processDue(at(WINDOW + 5));
      expect(registry.slashSolver).toHaveBeenCalledTimes(1);
      expect(await state()).toBe("submitted");
    });

    it("gives up after max attempts: cancels, compensates, and alerts", async () => {
      await detect();
      registry.slashSolver.mockResolvedValue(ok({ submitted: false, failed: true, detail: "simulation failed" }));
      const errorLog = jest.spyOn((pipeline as unknown as { logger: { error: () => void } }).logger, "error").mockImplementation();

      let t = WINDOW;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await pipeline.processDue(at(t));
        t += 3600;
      }

      expect(registry.slashSolver).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(await slashes.findByIntent(intentId)).toMatchObject({
        state: "cancelled",
        cancelReason: "submit_failed",
        attempts: MAX_ATTEMPTS,
      });
      expect(await fillsFailed()).toBe(0);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("ALERT"));
    });

    it("an unexpected throw is retried, not fatal to the batch", async () => {
      await detect();
      registry.slashSolver.mockRejectedValueOnce(new Error("kaboom"));
      await pipeline.processDue(at(WINDOW));
      expect(await slashes.findByIntent(intentId)).toMatchObject({
        state: "challenge_window",
        lastError: expect.stringContaining("kaboom"),
      });
    });
  });

  describe("scenario: kill-switch pause (issue #477)", () => {
    it("defers the slash without consuming attempts, then submits after resume", async () => {
      await detect();
      registry.slashSolver.mockRejectedValue(
        new KillSwitchActiveException({
          reasonCode: "INCIDENT",
          reason: "paused",
          scope: "operation",
          chain: "stellar",
          token: null,
          operation: "slash",
        } as never),
      );

      let t = WINDOW;
      for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
        await pipeline.processDue(at(t));
        t += 61;
      }
      const row = await slashes.findByIntent(intentId);
      expect(row).toMatchObject({ state: "challenge_window", attempts: 0, lastError: expect.stringContaining("kill-switch") });
      expect(await fillsFailed()).toBe(1); // not compensated: the slash is only paused

      registry.slashSolver.mockReset();
      registry.slashSolver.mockResolvedValue(ok());
      await pipeline.processDue(at(t + 61));
      expect(await state()).toBe("submitted");
    });
  });

  describe("confirmation", () => {
    beforeEach(async () => {
      await detect();
      await pipeline.processDue(at(WINDOW));
    });

    it("confirms on success", async () => {
      confirmation.check.mockResolvedValueOnce({ status: "success", ledger: 1 });
      await pipeline.processDue(at(WINDOW + 10));
      expect(await slashes.findByIntent(intentId)).toMatchObject({ state: "confirmed", confirmedAt: at(WINDOW + 10) });
      expect(metrics.recordSlashTransition).toHaveBeenCalledWith("confirmed");
    });

    it("waits while not found within the grace period", async () => {
      await pipeline.processDue(at(WINDOW + 10));
      expect(await state()).toBe("submitted");
    });

    it("re-opens for re-verification and resubmission when the tx failed or vanished", async () => {
      confirmation.check.mockResolvedValueOnce({ status: "failed", ledger: 1 });
      await pipeline.processDue(at(WINDOW + 10));
      expect(await slashes.findByIntent(intentId)).toMatchObject({ state: "challenge_window", attempts: 1 });

      await pipeline.processDue(at(WINDOW + 100));
      expect(registry.slashSolver).toHaveBeenCalledTimes(2);
      expect(verifier.findLandedFill).toHaveBeenCalledTimes(2);

      await pipeline.processDue(at(WINDOW + 100 + 121)); // not found past grace
      expect(await slashes.findByIntent(intentId)).toMatchObject({
        state: "challenge_window",
        lastError: expect.stringContaining("not found"),
      });
    });

    it("backs off when the confirmation lookup itself fails", async () => {
      confirmation.check.mockRejectedValueOnce(new Error("RPC down"));
      await pipeline.processDue(at(WINDOW + 10));
      const row = await slashes.findByIntent(intentId);
      expect(row).toMatchObject({ state: "submitted", lastError: expect.stringContaining("RPC down") });
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(at(WINDOW + 10).getTime());
    });
  });

  describe("edge cases", () => {
    it("clock skew: judges timeliness against fillDeadline + tolerance, on chain time", async () => {
      await detect();
      await pipeline.processDue(at(WINDOW));
      expect(verifier.findLandedFill.mock.calls[0][2]).toBe(fillDeadline + SKEW);
    });

    it("solver deregistered mid-window is still slashed (deregistration is not an escape hatch)", async () => {
      await detect();
      await solvers.deregister(solver);
      await pipeline.processDue(at(WINDOW));
      expect(registry.slashSolver).toHaveBeenCalledTimes(1);
      expect(intents.getAuditLog(intentId).at(-1)?.metadata).toMatchObject({ solverActive: false });
    });

    it("solver with no record is cancelled and compensated rather than submitted", async () => {
      await detect();
      jest.spyOn(solvers, "get").mockResolvedValueOnce(undefined);
      const rollback = jest.spyOn(solvers, "rollbackPenalty");
      await pipeline.processDue(at(WINDOW));
      expect(registry.slashSolver).not.toHaveBeenCalled();
      expect(await slashes.findByIntent(intentId)).toMatchObject({ state: "cancelled", cancelReason: "solver_not_found" });
      expect(rollback).toHaveBeenCalledWith(intentId, solver);
    });

    it("compensation survives a restart that lost the in-memory penalty record", async () => {
      await detect();
      (solvers as unknown as { pendingPenalties: Map<string, unknown> }).pendingPenalties.clear();
      await pipeline.cancelByAdmin(intentId, "ops", "after restart");
      expect(await fillsFailed()).toBe(0);
    });

    it("leaves the intent alone if it is no longer `slashed`", async () => {
      await detect();
      await intents.update(intentId, { state: "filled" });
      await pipeline.cancelByAdmin(intentId, "ops", "already filled");
      expect((await intents.get(intentId))?.state).toBe("filled");
    });

    it("skips rows another worker has leased, and overlapping passes", async () => {
      await detect();
      await slashes.claim(intentId, at(0), at(WINDOW + 60));
      await pipeline.processDue(at(WINDOW));
      expect(registry.slashSolver).not.toHaveBeenCalled();

      const claim = jest.spyOn(slashes, "claim").mockResolvedValueOnce(false);
      await pipeline.processDue(at(WINDOW + 61));
      expect(claim).toHaveBeenCalled();
      expect(registry.slashSolver).not.toHaveBeenCalled();

      let release!: () => void;
      jest.spyOn(slashes, "findDue").mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve([]))),
      );
      const first = pipeline.processDue(at(WINDOW + 62));
      await pipeline.processDue(at(WINDOW + 62)); // overlapping → no-op
      release();
      await first;
    });

    it("exposes lookup and listing", async () => {
      await detect();
      expect((await pipeline.getByIntent(intentId))?.intentId).toBe(intentId);
      expect(await pipeline.list("challenge_window", 10)).toHaveLength(1);
      expect(await pipeline.list("confirmed", 10)).toHaveLength(0);
    });

    it("runs on an interval and logs failures", () => {
      jest.useFakeTimers();
      try {
        const process = jest.spyOn(pipeline, "processDue").mockRejectedValue(new Error("tick failed"));
        const errorLog = jest.spyOn((pipeline as unknown as { logger: { error: () => void } }).logger, "error").mockImplementation();
        pipeline.onModuleInit();
        jest.advanceTimersByTime(15_000);
        expect(process).toHaveBeenCalledTimes(1);
        return Promise.resolve().then(() => expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("tick failed")));
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("lost races (another worker or an admin won the conditional transition)", () => {
    const loseNextTransition = () => jest.spyOn(slashes, "transition").mockResolvedValueOnce(null);

    it("detect returns the stored row if the window was already opened elsewhere", async () => {
      loseNextTransition();
      const slash = await detect();
      expect(slash.state).toBe("detected");
      expect(metrics.recordSlashTransition).not.toHaveBeenCalledWith("challenge_window");
    });

    it("does not record a submission it lost", async () => {
      await detect();
      loseNextTransition();
      await pipeline.processDue(at(WINDOW));
      expect(metrics.recordSlashTransition).not.toHaveBeenCalledWith("submitted", expect.anything());
    });

    it("does not record a confirmation or reopen it lost", async () => {
      await detect();
      await pipeline.processDue(at(WINDOW));

      confirmation.check.mockResolvedValueOnce({ status: "success", ledger: 1 });
      loseNextTransition();
      await pipeline.processDue(at(WINDOW + 10));
      expect(metrics.recordSlashTransition).not.toHaveBeenCalledWith("confirmed");

      confirmation.check.mockResolvedValueOnce({ status: "failed", ledger: 1 });
      loseNextTransition();
      await pipeline.processDue(at(WINDOW + 20));
      expect(registry.slashSolver).toHaveBeenCalledTimes(1);
    });

    it("releases a broadcast row with no tx hash, and treats a missing submittedAt as past grace", async () => {
      await detect();
      await slashes.transition(intentId, ["challenge_window"], { state: "submitted", simulated: false });
      await pipeline.processDue(at(WINDOW)); // no txHash → released, nothing checked
      expect(confirmation.check).not.toHaveBeenCalled();

      await slashes.transition(intentId, ["submitted"], { txHash: "h" });
      await pipeline.processDue(at(WINDOW + 1));
      expect(await slashes.findByIntent(intentId)).toMatchObject({ state: "challenge_window" });
    });

    it("stringifies non-Error failures and defaults processDue's clock", async () => {
      await slashes.createIfAbsent({
        intentId, solverAddress: solver, reason: "r", fillDeadline, detectedAt: new Date(0), challengeEndsAt: new Date(0),
      });
      await slashes.transition(intentId, ["detected"], { state: "challenge_window" });
      verifier.findLandedFill.mockRejectedValueOnce("plain string");
      await pipeline.processDue();
      expect((await slashes.findByIntent(intentId))?.lastError).toContain("plain string");
    });
  });
});
