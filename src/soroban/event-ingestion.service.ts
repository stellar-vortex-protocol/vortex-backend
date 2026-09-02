import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { logger } from "../common/logger";
import { SorobanService } from "./soroban.service";

const POLL_INTERVAL_MS = 10_000;
const RECONCILE_INTERVAL_MS = 60_000;
const STALE_INTENT_THRESHOLD_SECONDS = 300;

// Bound the in-memory dedupe set so long-lived processes don't leak memory.
// Once we've tracked this many keys we drop the oldest (lowest-ledger) ones,
// which is safe because we never re-poll ledgers that far behind the cursor.
const MAX_TRACKED_KEYS = 10_000;

export interface DedupeKeyParts {
  ledgerSequence: number;
  eventIndex: number;
}

// Soroban RPC event ids are "<ledgerSeq>-<eventIndexInLedger>"; we only use
// the trailing segment here since `EventResponse.ledger` is the source of
// truth for the ledger sequence.
export function parseEventIndex(eventId: string): number {
  const parts = eventId.split("-");
  const index = Number(parts[parts.length - 1]);
  return Number.isFinite(index) ? index : 0;
}

export function buildDedupeKey({ ledgerSequence, eventIndex }: DedupeKeyParts): string {
  return `${ledgerSequence}:${eventIndex}`;
}

@Injectable()
export class EventIngestionService implements OnModuleInit, OnModuleDestroy {
  private interval?: NodeJS.Timeout;
  private reconcileInterval?: NodeJS.Timeout;
  private readonly seenKeys = new Set<string>();
  private readonly lastIntentUpdateById = new Map<string, number>();
  private nextStartLedger?: number;
  processedCount = 0;
  duplicateCount = 0;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      this.poll().catch((err) => logger.error(`[event-ingestion] poll failed: ${err instanceof Error ? err.message : String(err)}`));
    }, POLL_INTERVAL_MS);

    this.reconcileInterval = setInterval(() => {
      this.reconcileStaleIntents().catch((err) => {
        logger.error(
          `[event-ingestion] stale-intent reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, RECONCILE_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
  }

  async poll(): Promise<void> {
    const settlementContractId = this.configService.get("stellar.settlementContractId", { infer: true });
    if (!settlementContractId) return;

    let startLedger = this.nextStartLedger;
    if (startLedger === undefined) {
      const latest = await this.sorobanService.getLatestLedger();
      startLedger = latest.sequence;
    }

    const response = await this.sorobanService.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [settlementContractId] }],
    });

    for (const event of response.events) {
      this.ingest(event);
    }

    this.nextStartLedger = response.latestLedger + 1;
  }

  // Skips events already seen at this ledger+index, which protects against
  // redelivery after a restart (cursor rewinds) or overlapping poll windows.
  ingest(event: SorobanRpc.Api.EventResponse): boolean {
    const dedupeKey = buildDedupeKey({
      ledgerSequence: event.ledger,
      eventIndex: parseEventIndex(event.id),
    });

    if (this.seenKeys.has(dedupeKey)) {
      this.duplicateCount++;
      return false;
    }

    this.markSeen(dedupeKey);
    this.processEvent(event);
    this.processedCount++;
    return true;
  }

  private markSeen(dedupeKey: string) {
    this.seenKeys.add(dedupeKey);
    if (this.seenKeys.size > MAX_TRACKED_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest !== undefined) this.seenKeys.delete(oldest);
    }
  }

  private processEvent(event: SorobanRpc.Api.EventResponse): void {
    const topic = event.topic.map((scVal) => {
      try {
        return scValToNative(scVal);
      } catch {
        return undefined;
      }
    });

    const eventName = typeof topic[0] === "string" ? topic[0] : undefined;
    if (eventName === "intent_filled") {
      this.handleIntentFilled(event, topic);
    }

    const intentId = typeof topic[1] === "string" ? topic[1] : undefined;
    if (intentId) {
      this.lastIntentUpdateById.set(intentId, Math.floor(Date.now() / 1000));
    }
  }

  private handleIntentFilled(event: SorobanRpc.Api.EventResponse, topic: unknown[]): void {
    logger.info(
      `[event-ingestion] intent_filled event at ledger=${event.ledger} txHash=${event.txHash} topic=${JSON.stringify(topic)}`,
    );
  }

  private async reconcileStaleIntents(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const [intentId, lastUpdated] of this.lastIntentUpdateById.entries()) {
      if (now - lastUpdated <= STALE_INTENT_THRESHOLD_SECONDS) continue;

      logger.warn(
        `[event-ingestion] stale intent state detected for intent=${intentId} lastUpdatedSecondsAgo=${now - lastUpdated}; polling chain for reconciliation`,
      );

      const settlementContractId = this.configService.get("stellar.settlementContractId", { infer: true });
      if (!settlementContractId) continue;

      const latestLedger = await this.sorobanService.getLatestLedger();
      await this.sorobanService.getEvents({
        startLedger: Math.max(1, latestLedger.sequence - 1),
        filters: [{ type: "contract", contractIds: [settlementContractId] }],
      });

      this.lastIntentUpdateById.set(intentId, Math.floor(Date.now() / 1000));
    }
  }
}
