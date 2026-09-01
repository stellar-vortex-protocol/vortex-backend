import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SorobanService } from "./soroban.service";
import { SolversService } from "../solvers/solvers.service";

const POLL_INTERVAL_MS = 10_000;

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
  private readonly seenKeys = new Set<string>();
  private nextStartLedger?: number;
  processedCount = 0;
  duplicateCount = 0;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly solversService: SolversService,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      this.poll().catch((err) => console.error("[event-ingestion] poll failed", err));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
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
    } else if (eventName === "solver_slashed") {
      // Fire-and-forget: penalty confirmation is non-blocking relative to
      // ingestion — a reconciliation failure is logged but never stalls the
      // poll loop.
      this.handleSolverSlashed(event, topic).catch((err) =>
        console.error(
          `[event-ingestion] solver_slashed reconciliation failed at ledger=${event.ledger}: ${(err as Error).message}`,
        ),
      );
    }
  }

  private handleIntentFilled(event: SorobanRpc.Api.EventResponse, topic: unknown[]): void {
    console.log(`[event-ingestion] intent_filled event at ledger=${event.ledger} txHash=${event.txHash}`, topic);
  }

  /**
   * Handles a solver_slashed event emitted by the Soroban solver-registry
   * contract once a slash transaction is confirmed on-chain.
   *
   * Expected topic layout (positions 1+ after the event name at position 0):
   *   topic[1] — solver address (string)
   *   topic[2] — intentId (string)
   *   topic[3] — slash amount (string or bigint)
   *
   * Calls SolversService.confirmPenalty() which reconciles bondAmount and
   * marks the penalty as "confirmed" in the in-memory pendingPenalties map.
   *
   * If topic values cannot be extracted (malformed event), a warning is logged
   * and the event is silently skipped — this protects against a bad contract
   * event bringing down the ingestion loop.
   */
  private async handleSolverSlashed(
    event: SorobanRpc.Api.EventResponse,
    topic: unknown[],
  ): Promise<void> {
    const solverAddress = typeof topic[1] === "string" ? topic[1] : undefined;
    const intentId = typeof topic[2] === "string" ? topic[2] : undefined;
    const rawAmount = topic[3];
    const slashAmount =
      typeof rawAmount === "bigint"
        ? rawAmount.toString()
        : typeof rawAmount === "string"
          ? rawAmount
          : undefined;

    if (!solverAddress || !intentId || !slashAmount) {
      console.warn(
        `[event-ingestion] solver_slashed event at ledger=${event.ledger} has unexpected topic shape; skipping reconciliation`,
        { solverAddress, intentId, slashAmount, rawTopic: topic },
      );
      return;
    }

    console.log(
      `[event-ingestion] solver_slashed confirmed: solver=${solverAddress} intentId=${intentId} slashAmount=${slashAmount} ledger=${event.ledger}`,
    );

    await this.solversService.confirmPenalty(intentId, slashAmount);
  }
}
