import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { KillSwitchActiveException } from "../killswitch/killswitch.guard";
import { MetricsService } from "../metrics/metrics.service";
import { InMemoryIntentsRepository } from "../intents/intents.repository";
import { InMemoryIntentsUnitOfWork } from "../intents/intents.unit-of-work";
import { IntentsService } from "../intents/intents.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProtocolParamsService } from "../governance/params.service";
import { InMemoryOutboxRepository } from "./outbox.repository";
import { createIntentEntry } from "./outbox-operations";
import { OutboxRelayService } from "./outbox-relay.service";
import { InvokeContractOptions, InvokeContractParams, StellarTxService } from "./stellar-tx.service";
import { TxConfirmation, TxConfirmationService } from "./tx-confirmation.service";

const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;

function intentFor(intentId: string) {
  return {
    intentId,
    user: Keypair.random().publicKey(),
    srcChain: "ethereum" as const,
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" as const },
    srcAmount: "1000000",
    dstToken: { contract: CONTRACT_ID, symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open" as const,
    createdAt: 1,
    deadline: 2_000_000_000,
  };
}

function config(overrides: Partial<AppConfig["outbox"]> = {}, settlementContractId = CONTRACT_ID) {
  const outbox: AppConfig["outbox"] = {
    relayEnabled: true,
    relayIntervalMs: 1000,
    batchSize: 10,
    maxAttempts: MAX_ATTEMPTS,
    leaseSeconds: LEASE_SECONDS,
    ...overrides,
  };
  return {
    get: (key: string) =>
      key === "outbox" ? outbox : key === "stellar.settlementContractId" ? settlementContractId : undefined,
  } as unknown as ConfigService<AppConfig, true>;
}

describe("OutboxRelayService (#396)", () => {
  let outbox: InMemoryOutboxRepository;
  let invokeContract: jest.Mock<Promise<{ hash: string; status: string; dryRun: boolean }>, [InvokeContractParams, InvokeContractOptions?]>;
  let check: jest.Mock<Promise<TxConfirmation>, [string]>;
  let metrics: { recordOutboxOutcome: jest.Mock; setOutboxBacklog: jest.Mock };
  let relay: OutboxRelayService;
  let now: Date;

  /** Default fake network: sign → beforeSubmit(hash) → accepted as PENDING. */
  function submitsAs(hash: string) {
    invokeContract.mockImplementationOnce(async (_params, options) => {
      await options?.beforeSubmit?.(hash);
      return { hash, status: "PENDING", dryRun: false };
    });
  }

  function build(cfg = config()) {
    relay = new OutboxRelayService(
      outbox,
      { invokeContract } as unknown as StellarTxService,
      { check } as unknown as TxConfirmationService,
      metrics as unknown as MetricsService,
      cfg,
    );
  }

  const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);

  beforeEach(() => {
    outbox = new InMemoryOutboxRepository();
    invokeContract = jest.fn();
    check = jest.fn().mockResolvedValue({ status: "not_found" });
    metrics = { recordOutboxOutcome: jest.fn(), setOutboxBacklog: jest.fn() };
    now = new Date(Date.now() + 1000);
    build();
  });

  afterEach(() => relay.onModuleDestroy());

  it("submits a pending row, records the envelope before broadcast, then confirms it", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    let hashAtSubmit: string | undefined;
    invokeContract.mockImplementationOnce(async (params, options) => {
      expect(params).toMatchObject({ contractId: CONTRACT_ID, method: "create_intent" });
      await options?.beforeSubmit?.("h1");
      hashAtSubmit = (await outbox.findByIntent("i1"))[0].envelopeHash;
      return { hash: "h1", status: "PENDING", dryRun: false };
    });

    expect(await relay.tick(now)).toMatchObject({ claimed: 1, submitted: 1 });
    expect(hashAtSubmit).toBe("h1");
    expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "submitted", txHash: "h1" });

    check.mockResolvedValueOnce({ status: "success", ledger: 10 });
    expect(await relay.tick(later(5))).toMatchObject({ confirmed: 1 });
    expect((await outbox.findByIntent("i1"))[0].status).toBe("confirmed");
    expect(metrics.recordOutboxOutcome).toHaveBeenCalledWith("confirmed");
    expect(metrics.setOutboxBacklog).toHaveBeenCalled();
  });

  it("confirms immediately when the live path already waited for confirmation (SUCCESS)", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    invokeContract.mockImplementationOnce(async (_p, options) => {
      await options?.beforeSubmit?.("h-sync");
      return { hash: "h-sync", status: "SUCCESS", dryRun: false };
    });

    expect(await relay.tick(now)).toMatchObject({ submitted: 1, confirmed: 1 });
    expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "confirmed", txHash: "h-sync" });
    expect(check).not.toHaveBeenCalled();

    jest.spyOn(outbox, "markConfirmed").mockResolvedValueOnce(false);
    await outbox.enqueue(createIntentEntry(intentFor("i2")));
    invokeContract.mockResolvedValueOnce({ hash: "h2", status: "SUCCESS", dryRun: false });
    expect(await relay.tick(later(1))).toMatchObject({ confirmed: 0 });
  });

  it("marks rows simulated under ONCHAIN_DRY_RUN and lets the next row for the intent proceed", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    await outbox.enqueue({ intentId: "i1", operation: "cancel_intent", payload: { intentId: "i1", user: Keypair.random().publicKey() } });
    invokeContract.mockResolvedValue({ hash: "dry-run-no-hash", status: "DRY_RUN", dryRun: true });

    expect(await relay.tick(now)).toMatchObject({ simulated: 1 });
    expect(await relay.tick(later(1))).toMatchObject({ simulated: 1 });
    expect((await outbox.findByIntent("i1")).map((r) => r.status)).toEqual(["simulated", "simulated"]);
  });

  describe("crash injection", () => {
    it("crash between DB commit and submit: the committed row is picked up by the next relay", async () => {
      // The unit of work commits intent + outbox row, then the process dies
      // before any relay tick — nothing was submitted.
      const repo = new InMemoryIntentsRepository();
      const intents = new IntentsService(
        repo,
        { get: (k: string) => (k === "onchainIntentsEnabled" ? true : k === "stellar.settlementContractId" ? CONTRACT_ID : undefined) } as unknown as ConfigService<AppConfig, true>,
        {} as StellarTxService,
        { intentAuditLog: { create: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService,
        undefined,
        undefined,
        { snapshotForChain: jest.fn().mockReturnValue({ version: 0, deadlineSeconds: 1800, fillWindowSeconds: 600 }) } as unknown as ProtocolParamsService,
        undefined,
        new InMemoryIntentsUnitOfWork(repo, outbox),
      );
      const { intentId: _ignored, state: _state, createdAt: _createdAt, ...data } = intentFor("ignored");
      const created = await intents.create(data);
      expect(invokeContract).not.toHaveBeenCalled();

      // "Restart": a fresh relay over the same durable outbox.
      build();
      submitsAs("h-after-restart");
      expect(await relay.tick(now)).toMatchObject({ submitted: 1 });
      expect((await outbox.findByIntent(created.intentId))[0].txHash).toBe("h-after-restart");
    });

    it("crash after broadcast, before markSubmitted: detects the landed tx and does not resubmit", async () => {
      await outbox.enqueue(createIntentEntry(intentFor("i1")));
      invokeContract.mockImplementationOnce(async (_p, options) => {
        await options?.beforeSubmit?.("h-landed");
        throw new Error("process killed");
      });
      // Simulate the kill: the row is left `processing` with the envelope hash
      // (the catch path's retry write is lost along with the process).
      const retrySpy = jest.spyOn(outbox, "scheduleRetry").mockResolvedValueOnce(false);
      await relay.tick(now);
      retrySpy.mockRestore();
      expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "processing", envelopeHash: "h-landed" });

      // Before the lease expires nobody touches it.
      expect(await relay.tick(later(LEASE_SECONDS - 1))).toMatchObject({ claimed: 0 });

      check.mockResolvedValueOnce({ status: "success", ledger: 7 });
      expect(await relay.tick(later(LEASE_SECONDS + 1))).toMatchObject({ claimed: 1, confirmed: 1 });
      expect(invokeContract).toHaveBeenCalledTimes(1);
      expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "confirmed", txHash: "h-landed" });
    });

    it("crash after signing, envelope never landed: rebuilds and resubmits once the lease expires", async () => {
      await outbox.enqueue(createIntentEntry(intentFor("i1")));
      invokeContract.mockImplementationOnce(async (_p, options) => {
        await options?.beforeSubmit?.("h-lost");
        throw new Error("process killed");
      });
      const retrySpy = jest.spyOn(outbox, "scheduleRetry").mockResolvedValueOnce(false);
      await relay.tick(now);
      retrySpy.mockRestore();

      check.mockResolvedValueOnce({ status: "not_found" });
      submitsAs("h-rebuilt");
      expect(await relay.tick(later(LEASE_SECONDS + 1))).toMatchObject({ submitted: 1 });
      expect(check).toHaveBeenCalledWith("h-lost");
      expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "submitted", txHash: "h-rebuilt", attempts: 2 });
    });

    it("a reclaimed row whose earlier envelope failed on-chain is retried", async () => {
      await outbox.enqueue(createIntentEntry(intentFor("i1")));
      invokeContract.mockImplementationOnce(async (_p, options) => {
        await options?.beforeSubmit?.("h-failed");
        throw new Error("process killed");
      });
      const retrySpy = jest.spyOn(outbox, "scheduleRetry").mockResolvedValueOnce(false);
      await relay.tick(now);
      retrySpy.mockRestore();

      check.mockResolvedValueOnce({ status: "failed", ledger: 9 });
      expect(await relay.tick(later(LEASE_SECONDS + 1))).toMatchObject({ retried: 1 });
      expect((await outbox.findByIntent("i1"))[0]).toMatchObject({
        status: "pending",
        lastError: expect.stringContaining("h-failed"),
      });
    });
  });

  it("a kill-switch pause puts the row back without consuming an attempt (never dead-letters)", async () => {
    build(config({ maxAttempts: 1 }));
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    const paused = new KillSwitchActiveException({
      reasonCode: "INCIDENT",
      reason: "paused",
      scope: "operation",
      chain: "stellar",
      token: null,
      operation: "onchain",
    } as never);
    invokeContract.mockRejectedValue(paused);

    for (let i = 0; i < 5; i++) {
      const t = i === 0 ? now : (await outbox.findByIntent("i1"))[0].nextAttemptAt;
      expect(await relay.tick(t)).toMatchObject({ claimed: 1, paused: 1, dead: 0, retried: 0 });
    }
    const [row] = await outbox.findByIntent("i1");
    expect(row).toMatchObject({ status: "pending", attempts: 0, lastError: expect.stringContaining("kill-switch") });

    // Resume: the next attempt submits normally.
    invokeContract.mockReset();
    submitsAs("h-after-resume");
    expect(await relay.tick(row.nextAttemptAt)).toMatchObject({ submitted: 1 });

    // A lost fence on release is not counted.
    await outbox.enqueue(createIntentEntry(intentFor("i2")));
    invokeContract.mockRejectedValueOnce(paused);
    jest.spyOn(outbox, "release").mockResolvedValueOnce(false);
    expect(await relay.tick(later(3600))).toMatchObject({ paused: 0 });
  });

  it("does not submit when the lease was lost before broadcast", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    jest.spyOn(outbox, "recordEnvelope").mockResolvedValueOnce(false);
    const sent = jest.fn();
    invokeContract.mockImplementationOnce(async (_p, options) => {
      await options?.beforeSubmit?.("h");
      sent();
      return { hash: "h", status: "PENDING", dryRun: false };
    });

    await relay.tick(now);
    expect(sent).not.toHaveBeenCalled();
    expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "pending", lastError: expect.stringContaining("lost lease") });
  });

  it("keeps per-intent order across ticks while other intents proceed in parallel", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("a")));
    await outbox.enqueue({ intentId: "a", operation: "cancel_intent", payload: { intentId: "a", user: Keypair.random().publicKey() } });
    await outbox.enqueue(createIntentEntry(intentFor("b")));
    const order: string[] = [];
    invokeContract.mockImplementation(async (params, options) => {
      order.push(params.method);
      const hash = `h${order.length}`;
      await options?.beforeSubmit?.(hash);
      return { hash, status: "PENDING", dryRun: false };
    });

    expect(await relay.tick(now)).toMatchObject({ claimed: 2, submitted: 2 });
    expect(order).toEqual(["create_intent", "create_intent"]);

    // a's cancel must wait for a's create to confirm.
    expect(await relay.tick(later(1))).toMatchObject({ claimed: 0 });

    check.mockImplementation(async (hash) => ({ status: hash === "h1" ? "success" : "not_found" }));
    expect(await relay.tick(later(2))).toMatchObject({ confirmed: 1, claimed: 1, submitted: 1 });
    expect(order).toEqual(["create_intent", "create_intent", "cancel_intent"]);
  });

  it("retries with exponential backoff and moves a poison row to dead with an alert", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    await outbox.enqueue({ intentId: "i1", operation: "cancel_intent", payload: { intentId: "i1", user: Keypair.random().publicKey() } });
    invokeContract.mockRejectedValue(new Error("RPC 503"));
    const errorLog = jest.spyOn((relay as unknown as { logger: { error: () => void } }).logger, "error").mockImplementation();

    expect(await relay.tick(now)).toMatchObject({ retried: 1 });
    let [row] = await outbox.findByIntent("i1");
    expect(row.nextAttemptAt.getTime() - now.getTime()).toBe(1000);

    expect(await relay.tick(new Date(row.nextAttemptAt.getTime()))).toMatchObject({ retried: 1 });
    const t2 = row.nextAttemptAt.getTime();
    [row] = await outbox.findByIntent("i1");
    expect(row.nextAttemptAt.getTime() - t2).toBe(2000);

    expect(await relay.tick(new Date(row.nextAttemptAt.getTime()))).toMatchObject({ dead: 1 });
    [row] = await outbox.findByIntent("i1");
    expect(row).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS, lastError: "RPC 503" });
    expect(metrics.recordOutboxOutcome).toHaveBeenCalledWith("dead");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("ALERT"));

    // The dead row blocks the intent's later operations.
    expect(await relay.tick(later(3600))).toMatchObject({ claimed: 0 });
  });

  it("caps the backoff", async () => {
    build(config({ maxAttempts: 100 }));
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    invokeContract.mockRejectedValue(new Error("nope"));
    let t = now;
    for (let i = 0; i < 12; i++) {
      await relay.tick(t);
      t = (await outbox.findByIntent("i1"))[0].nextAttemptAt;
    }
    const [row] = await outbox.findByIntent("i1");
    await relay.tick(row.nextAttemptAt);
    const [after] = await outbox.findByIntent("i1");
    expect(after.nextAttemptAt.getTime() - row.nextAttemptAt.getTime()).toBe(5 * 60_000);
  });

  it("retries when SETTLEMENT_CONTRACT_ID is missing at relay time", async () => {
    build(config({}, ""));
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    await relay.tick(now);
    expect(invokeContract).not.toHaveBeenCalled();
    expect((await outbox.findByIntent("i1"))[0].lastError).toContain("SETTLEMENT_CONTRACT_ID");
  });

  describe("confirmation of submitted rows", () => {
    beforeEach(async () => {
      await outbox.enqueue(createIntentEntry(intentFor("i1")));
      submitsAs("h1");
      await relay.tick(now);
    });

    it("rebuilds when the transaction failed on-chain", async () => {
      check.mockResolvedValueOnce({ status: "failed", ledger: 3 });
      expect(await relay.tick(later(5))).toMatchObject({ retried: 1 });
      expect((await outbox.findByIntent("i1"))[0]).toMatchObject({ status: "pending", txHash: undefined });
    });

    it("waits while not found within the lease, rebuilds after it", async () => {
      expect(await relay.tick(later(LEASE_SECONDS - 10))).toMatchObject({ retried: 0, confirmed: 0 });
      expect((await outbox.findByIntent("i1"))[0].status).toBe("submitted");

      expect(await relay.tick(later(LEASE_SECONDS + 10))).toMatchObject({ retried: 1 });
      expect((await outbox.findByIntent("i1"))[0].lastError).toContain("not found after lease");
    });

    it("treats a lookup failure as no evidence and looks again next tick", async () => {
      check.mockRejectedValueOnce(new Error("RPC down"));
      expect(await relay.tick(later(LEASE_SECONDS + 10))).toMatchObject({ retried: 0, confirmed: 0 });
      expect((await outbox.findByIntent("i1"))[0].status).toBe("submitted");
    });
  });

  it("skips overlapping ticks", async () => {
    await outbox.enqueue(createIntentEntry(intentFor("i1")));
    let release!: () => void;
    invokeContract.mockImplementationOnce(
      (_p, options) =>
        new Promise((resolve) => {
          release = () => {
            void options?.beforeSubmit?.("h").then(() => resolve({ hash: "h", status: "PENDING", dryRun: false }));
          };
        }),
    );
    const first = relay.tick(now);
    await new Promise((r) => setImmediate(r));
    expect(await relay.tick(now)).toMatchObject({ claimed: 0 });
    release();
    expect(await first).toMatchObject({ submitted: 1 });
  });

  it("survives a backlog gauge failure", async () => {
    jest.spyOn(outbox, "countByStatus").mockRejectedValueOnce(new Error("db"));
    await expect(relay.tick(now)).resolves.toMatchObject({ claimed: 0 });
  });

  it("starts an interval on init only when enabled", () => {
    jest.useFakeTimers();
    try {
      const tick = jest.spyOn(relay, "tick").mockResolvedValue({} as never);
      relay.onModuleInit();
      jest.advanceTimersByTime(1000);
      expect(tick).toHaveBeenCalledTimes(1);
      relay.onModuleDestroy();

      build(config({ relayEnabled: false }));
      const disabledTick = jest.spyOn(relay, "tick");
      relay.onModuleInit();
      jest.advanceTimersByTime(5000);
      expect(disabledTick).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("logs, but does not crash, when an interval tick throws", () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(relay, "tick").mockRejectedValue(new Error("boom"));
      const errorLog = jest.spyOn((relay as unknown as { logger: { error: () => void } }).logger, "error").mockImplementation();
      relay.onModuleInit();
      jest.advanceTimersByTime(1000);
      return Promise.resolve().then(() => {
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("boom"));
      });
    } finally {
      jest.useRealTimers();
    }
  });

  describe("lost fences (another worker reclaimed the row)", () => {
    it("does not count outcomes whose fenced write lost", async () => {
      await outbox.enqueue(createIntentEntry(intentFor("i1")));
      submitsAs("h1");
      jest.spyOn(outbox, "markSubmitted").mockResolvedValueOnce(false);
      expect(await relay.tick(now)).toMatchObject({ claimed: 1, submitted: 0 });

      invokeContract.mockResolvedValueOnce({ hash: "x", status: "DRY_RUN", dryRun: true });
      jest.spyOn(outbox, "markSimulated").mockResolvedValueOnce(false);
      expect(await relay.tick(later(LEASE_SECONDS + 1))).toMatchObject({ simulated: 0 });
    });

    it("does not count a lost confirmation, dead-letter, or retry", async () => {
      await outbox.enqueue(createIntentEntry(intentFor("i1")));
      submitsAs("h1");
      await relay.tick(now);
      check.mockResolvedValue({ status: "success", ledger: 1 });
      jest.spyOn(outbox, "markConfirmed").mockResolvedValueOnce(false);
      expect(await relay.tick(later(1))).toMatchObject({ confirmed: 0 });

      // Reclaimed row whose envelope landed, but the confirm write loses.
      await outbox.enqueue(createIntentEntry(intentFor("i2")));
      invokeContract.mockImplementationOnce(async (_p, options) => {
        await options?.beforeSubmit?.("h2");
        throw new Error("killed");
      });
      const retry = jest.spyOn(outbox, "scheduleRetry").mockResolvedValueOnce(false);
      expect(await relay.tick(later(2))).toMatchObject({ retried: 0 });
      retry.mockRestore();
      jest.spyOn(outbox, "findSubmitted").mockResolvedValueOnce([]);
      jest.spyOn(outbox, "markConfirmed").mockResolvedValueOnce(false);
      expect(await relay.tick(later(LEASE_SECONDS + 5))).toMatchObject({ claimed: 1, confirmed: 0 });

      build(config({ maxAttempts: 1 }));
      await outbox.enqueue(createIntentEntry(intentFor("i3")));
      invokeContract.mockRejectedValueOnce("not an Error");
      jest.spyOn(outbox, "markDead").mockResolvedValueOnce(false);
      expect(await relay.tick(later(LEASE_SECONDS + 10))).toMatchObject({ dead: 0 });
    });

    it("skips submitted rows without a tx hash and defaults the clock", async () => {
      jest.spyOn(outbox, "findSubmitted").mockResolvedValueOnce([
        { id: "1", intentId: "i", operation: "create_intent", payload: {}, status: "submitted", attempts: 1,
          nextAttemptAt: now, createdAt: now, updatedAt: now },
      ]);
      await expect(relay.tick()).resolves.toMatchObject({ confirmed: 0, retried: 0 });
      expect(check).not.toHaveBeenCalled();
    });
  });
});
