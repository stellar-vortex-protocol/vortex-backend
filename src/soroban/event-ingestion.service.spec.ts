import { nativeToScVal } from "@stellar/stellar-sdk";
import { EventIngestionService } from "./event-ingestion.service";

function fakeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "0000000001-0000000000",
    type: "contract" as const,
    ledger: 1000,
    ledgerClosedAt: new Date().toISOString(),
    pagingToken: "0000000001-0000000000",
    inSuccessfulContractCall: true,
    txHash: "deadbeef",
    contractId: "CCONTRACT",
    topic: [nativeToScVal("intent_filled", { type: "symbol" })],
    value: nativeToScVal(42, { type: "u32" }),
    ...overrides,
  };
}

describe("EventIngestionService", () => {
  function build(contractId: string) {
    const configService = {
      get: jest.fn().mockReturnValue(contractId),
    };
    const sorobanService = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 500 }),
      getEvents: jest.fn().mockResolvedValue({ latestLedger: 500, events: [] }),
    };
    const intentsGateway = {
      broadcast: jest.fn(),
    };

    const service = new EventIngestionService(
      configService as never,
      sorobanService as never,
      intentsGateway as never,
    );

    return { service, configService, sorobanService, intentsGateway };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not poll when SETTLEMENT_CONTRACT_ID is unconfigured", async () => {
    const { service, sorobanService } = build("");

    await service.onModuleInit();
    service.onModuleDestroy();

    expect(sorobanService.getLatestLedger).not.toHaveBeenCalled();
    expect(sorobanService.getEvents).not.toHaveBeenCalled();
  });

  it("seeds startLedger from the latest ledger and polls with it on the first tick", async () => {
    jest.useFakeTimers();
    const { service, sorobanService } = build("CSETTLEMENT");

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(sorobanService.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: "contract", contractIds: ["CSETTLEMENT"] }],
        startLedger: 500,
        cursor: undefined,
      }),
    );

    service.onModuleDestroy();
  });

  it("broadcasts decoded events derived from the topic symbol", async () => {
    jest.useFakeTimers();
    const { service, sorobanService, intentsGateway } = build("CSETTLEMENT");
    sorobanService.getEvents.mockResolvedValueOnce({
      latestLedger: 501,
      events: [fakeEvent()],
    });

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(intentsGateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chain_intent_filled",
        contractId: "CSETTLEMENT",
        ledger: 1000,
        txHash: "deadbeef",
        data: 42,
      }),
    );

    service.onModuleDestroy();
  });

  it("skips events that were not part of a successful contract call", async () => {
    jest.useFakeTimers();
    const { service, sorobanService, intentsGateway } = build("CSETTLEMENT");
    sorobanService.getEvents.mockResolvedValueOnce({
      latestLedger: 501,
      events: [fakeEvent({ inSuccessfulContractCall: false })],
    });

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(intentsGateway.broadcast).not.toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it("carries the cursor forward instead of re-sending startLedger on later polls", async () => {
    jest.useFakeTimers();
    const { service, sorobanService } = build("CSETTLEMENT");
    sorobanService.getEvents.mockResolvedValueOnce({
      latestLedger: 501,
      events: [fakeEvent({ pagingToken: "cursor-1" })],
    });

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(sorobanService.getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-1", startLedger: undefined }),
    );

    service.onModuleDestroy();
  });

  it("stops polling after onModuleDestroy", async () => {
    jest.useFakeTimers();
    const { service, sorobanService } = build("CSETTLEMENT");

    await service.onModuleInit();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(sorobanService.getEvents).not.toHaveBeenCalled();
  });

  it("logs and keeps running when a poll fails", async () => {
    jest.useFakeTimers();
    const { service, sorobanService, intentsGateway } = build("CSETTLEMENT");
    sorobanService.getEvents.mockRejectedValueOnce(new Error("rpc down"));

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(intentsGateway.broadcast).not.toHaveBeenCalled();
    expect(sorobanService.getEvents).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
import { ConfigService } from "@nestjs/config";
import { nativeToScVal, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { buildDedupeKey, EventIngestionService, parseEventIndex } from "./event-ingestion.service";
import { SorobanService } from "./soroban.service";

function makeIntentFilledEvent(
  overrides: Partial<{ ledger: number; id: string; intentId: string }> = {},
): SorobanRpc.Api.EventResponse {
  const ledger = overrides.ledger ?? 1000;
  const id = overrides.id ?? `${String(ledger).padStart(10, "0")}-0000000001`;
  const intentId = overrides.intentId ?? "intent-abc";

  return {
    id,
    type: "contract",
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    pagingToken: id,
    inSuccessfulContractCall: true,
    txHash: `tx-${id}`,
    topic: [nativeToScVal("intent_filled", { type: "symbol" })],
    value: nativeToScVal(intentId, { type: "string" }),
  } as SorobanRpc.Api.EventResponse;
}

function makeConfigService(settlementContractId = "CSETTLEMENT"): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => {
      if (key === "stellar.settlementContractId") return settlementContractId;
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService<AppConfig, true>;
}

describe("EventIngestionService", () => {
  describe("buildDedupeKey / parseEventIndex", () => {
    it("derives the event index from the trailing segment of the event id", () => {
      expect(parseEventIndex("0000001000-0000000007")).toBe(7);
    });

    it("falls back to 0 for a malformed id", () => {
      expect(parseEventIndex("not-a-number")).toBe(0);
    });

    it("builds distinct keys for different ledgers with the same event index", () => {
      const a = buildDedupeKey({ ledgerSequence: 1000, eventIndex: 1 });
      const b = buildDedupeKey({ ledgerSequence: 1001, eventIndex: 1 });
      expect(a).not.toBe(b);
    });
  });

  describe("ingest", () => {
    let service: EventIngestionService;
    let sorobanService: SorobanService;

    beforeEach(() => {
      sorobanService = {} as SorobanService;
      service = new EventIngestionService(sorobanService, makeConfigService());
    });

    it("processes a new event exactly once", () => {
      const event = makeIntentFilledEvent();

      const result = service.ingest(event);

      expect(result).toBe(true);
      expect(service.processedCount).toBe(1);
      expect(service.duplicateCount).toBe(0);
    });

    it("dedupes a replayed event delivered twice (same ledger + event index)", () => {
      // Simulates the same on-chain event being redelivered, e.g. because a
      // poll window overlapped the previous one after a restart.
      const first = makeIntentFilledEvent({ ledger: 1000 });
      const replay = makeIntentFilledEvent({ ledger: 1000 });

      const firstResult = service.ingest(first);
      const replayResult = service.ingest(replay);

      expect(firstResult).toBe(true);
      expect(replayResult).toBe(false);
      expect(service.processedCount).toBe(1);
      expect(service.duplicateCount).toBe(1);
    });

    it("does not dedupe two distinct events for the same intent (different ledgers)", () => {
      const eventA = makeIntentFilledEvent({ ledger: 1000, intentId: "intent-abc" });
      const eventB = makeIntentFilledEvent({ ledger: 1001, intentId: "intent-abc" });

      expect(service.ingest(eventA)).toBe(true);
      expect(service.ingest(eventB)).toBe(true);
      expect(service.processedCount).toBe(2);
    });

    it("treats events with the same intent id but different event indices as distinct", () => {
      const eventA = makeIntentFilledEvent({ ledger: 1000, id: "0000001000-0000000001" });
      const eventB = makeIntentFilledEvent({ ledger: 1000, id: "0000001000-0000000002" });

      expect(service.ingest(eventA)).toBe(true);
      expect(service.ingest(eventB)).toBe(true);
      expect(service.processedCount).toBe(2);
    });
  });
});
