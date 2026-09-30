import { SorobanRpc } from "@stellar/stellar-sdk";
import { TxConfirmationService, TrackTxOptions } from "./tx-confirmation.service";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { FeeEscalationPolicy } from "./fee-escalation-policy";
import { TxConfirmed, TxFailed, TxExpired } from "./tx-events";

// EventEmitter2 is ESM-only; mock it for Jest's CommonJS environment
jest.mock("@nestjs/event-emitter", () => ({
  EventEmitter2: jest.fn().mockImplementation(() => ({ emit: jest.fn() })),
}));

function makePrisma(overrides: Partial<{
  queryRaw: jest.Mock;
  update: jest.Mock;
  upsert: jest.Mock;
}> = {}): PrismaService {
  return {
    pendingTransaction: {
      upsert: overrides.upsert ?? jest.fn().mockResolvedValue({}),
      update: overrides.update ?? jest.fn().mockResolvedValue({}),
    },
    $queryRaw: overrides.queryRaw ?? jest.fn().mockResolvedValue([]),
  } as unknown as PrismaService;
}

function makeSoroban(
  getTransactionResult: SorobanRpc.Api.GetTransactionResponse,
): SorobanService {
  return {
    getTransaction: jest.fn().mockResolvedValue(getTransactionResult),
    submitTransaction: jest.fn().mockResolvedValue({ status: "PENDING" }),
  } as unknown as SorobanService;
}

function makeSigner(configured = false): SignerService {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    getNetworkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
    getSecretKey: jest.fn().mockReturnValue(""),
  } as unknown as SignerService;
}

function makeMetrics(): MetricsService {
  return {
    txConfirmationOutcomes: { inc: jest.fn() },
    txConfirmationLatency: { observe: jest.fn() },
  } as unknown as MetricsService;
}

function makeFeePolicy(shouldEscalate = false): FeeEscalationPolicy {
  return {
    shouldEscalate: jest.fn().mockReturnValue(shouldEscalate),
    buildFeeBump: jest.fn().mockResolvedValue(null),
  } as unknown as FeeEscalationPolicy;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvents(): any {
  return { emit: jest.fn() };
}

const BASE_ROW = {
  id: 1n,
  tx_hash: "abc123",
  tx_xdr: "AAAA",
  intent_id: "intent-1",
  channel_key: null,
  status: "pending",
  max_track_until: Math.floor(Date.now() / 1000) + 300,
  attempts: 0,
  next_poll_at: Math.floor(Date.now() / 1000) - 1,
  last_fee_stroops: null,
  fee_bump_count: 0,
  created_at: new Date(),
};

describe("TxConfirmationService", () => {
  describe("track()", () => {
    it("upserts a pending transaction record", async () => {
      const upsert = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ upsert });
      const svc = new TxConfirmationService(
        prisma,
        makeSoroban({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND } as SorobanRpc.Api.GetTransactionResponse),
        makeSigner(),
        makeFeePolicy(),
        makeMetrics(),
        makeEvents(),
      );

      const opts: TrackTxOptions = {
        txHash: "abc123",
        txXdr: "AAAA",
        intentId: "intent-1",
        maxTrackUntil: Math.floor(Date.now() / 1000) + 300,
      };
      await svc.track(opts);

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { txHash: "abc123" },
          create: expect.objectContaining({ txHash: "abc123", status: "pending" }),
        }),
      );
    });
  });

  describe("processRow() via pollBatch()", () => {
    it("marks confirmed and emits TxConfirmed on SUCCESS", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ queryRaw: jest.fn().mockResolvedValue([BASE_ROW]), update });
      const soroban = makeSoroban({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 42,
      } as SorobanRpc.Api.GetSuccessfulTransactionResponse);
      const events = makeEvents();
      const metrics = makeMetrics();

      const svc = new TxConfirmationService(
        prisma, soroban, makeSigner(), makeFeePolicy(), metrics, events,
      );

      // Call the private pollBatch via onModuleInit's interval—instead directly
      // trigger it by casting to any
      await (svc as unknown as { pollBatch: () => Promise<void> }).pollBatch();

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "confirmed" } }),
      );
      expect(events.emit).toHaveBeenCalledWith(TxConfirmed.EVENT, expect.any(TxConfirmed));
      expect(metrics.txConfirmationOutcomes.inc).toHaveBeenCalledWith({ status: "confirmed" });
    });

    it("marks failed and emits TxFailed on FAILED (no fee bump)", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ queryRaw: jest.fn().mockResolvedValue([BASE_ROW]), update });
      const soroban = makeSoroban({
        status: SorobanRpc.Api.GetTransactionStatus.FAILED,
      } as SorobanRpc.Api.GetFailedTransactionResponse);
      const events = makeEvents();
      const metrics = makeMetrics();

      const svc = new TxConfirmationService(
        prisma, soroban, makeSigner(false), makeFeePolicy(false), metrics, events,
      );
      await (svc as unknown as { pollBatch: () => Promise<void> }).pollBatch();

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "failed" } }),
      );
      expect(events.emit).toHaveBeenCalledWith(TxFailed.EVENT, expect.any(TxFailed));
    });

    it("schedules retry with backoff on NOT_FOUND", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ queryRaw: jest.fn().mockResolvedValue([BASE_ROW]), update });
      const soroban = makeSoroban({
        status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
      } as SorobanRpc.Api.GetTransactionResponse);

      const svc = new TxConfirmationService(
        prisma, soroban, makeSigner(), makeFeePolicy(false), makeMetrics(), makeEvents(),
      );
      await (svc as unknown as { pollBatch: () => Promise<void> }).pollBatch();

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ attempts: 1 }),
        }),
      );
    });

    it("marks expired and emits TxExpired when past maxTrackUntil", async () => {
      const expiredRow = {
        ...BASE_ROW,
        max_track_until: Math.floor(Date.now() / 1000) - 10, // already expired
      };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ queryRaw: jest.fn().mockResolvedValue([expiredRow]), update });
      const events = makeEvents();
      const metrics = makeMetrics();

      const svc = new TxConfirmationService(
        prisma,
        makeSoroban({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND } as SorobanRpc.Api.GetTransactionResponse),
        makeSigner(),
        makeFeePolicy(),
        metrics,
        events,
      );
      await (svc as unknown as { pollBatch: () => Promise<void> }).pollBatch();

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "expired" } }),
      );
      expect(events.emit).toHaveBeenCalledWith(TxExpired.EVENT, expect.any(TxExpired));
      expect(metrics.txConfirmationOutcomes.inc).toHaveBeenCalledWith({ status: "expired" });
    });
  });
});
