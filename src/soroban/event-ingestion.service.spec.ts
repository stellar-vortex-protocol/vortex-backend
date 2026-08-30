import { ConfigService } from "@nestjs/config";
import { nativeToScVal, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import {
  buildDedupeKey,
  EventIngestionService,
  parseEventIndex,
} from "./event-ingestion.service";
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

function makeConfigService(
  settlementContractId = "CSETTLEMENT",
): ConfigService<AppConfig, true> {
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
      const eventA = makeIntentFilledEvent({
        ledger: 1000,
        id: "0000001000-0000000001",
      });
      const eventB = makeIntentFilledEvent({
        ledger: 1000,
        id: "0000001000-0000000002",
      });

      expect(service.ingest(eventA)).toBe(true);
      expect(service.ingest(eventB)).toBe(true);
      expect(service.processedCount).toBe(2);
    });
  });
});
