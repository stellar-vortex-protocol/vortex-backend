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
  });
});
