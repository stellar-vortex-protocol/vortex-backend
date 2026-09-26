import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";
import { SolversService } from "../solvers/solvers.service";
import { logger as rootLogger } from "../common/logger";

const POLL_INTERVAL_MS = 10_000;
const RECONCILE_INTERVAL_MS = 60_000;
const STALE_INTENT_THRESHOLD_SECONDS = 300;
const MAX_DEAD_LETTER_ATTEMPTS = 3;

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
  private readonly logger = new Logger(EventIngestionService.name);
  private interval?: NodeJS.Timeout;
  private reconcileInterval?: NodeJS.Timeout;
  private readonly lastIntentUpdateById = new Map<string, number>();
  processedCount = 0;
  duplicateCount = 0;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly solversService: SolversService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Run the first poll immediately on startup (don't wait for the interval)
    this.poll().catch((err) =>
      this.logger.error(
        `[event-ingestion] initial poll failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );

    this.interval = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.error(
          `[event-ingestion] poll failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, POLL_INTERVAL_MS);

    this.reconcileInterval = setInterval(() => {
      this.reconcileStaleIntents().catch((err) => {
        this.logger.error(
          `[event-ingestion] stale-intent reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, RECONCILE_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
  }

  async poll(): Promise<void> {
    const network = this.configService.get("stellar.network", { infer: true });
    const settlementContractId = this.configService.get(
      "stellar.settlementContractId",
      { infer: true },
    );
    if (!settlementContractId) return;

    // Load the persisted cursor, fall back to latest ledger on first run
    const cursor = await this.prisma.ingestionCursor.findFirst({
      where: { network, contractId: settlementContractId },
    });

    let startLedger: number;
    if (cursor) {
      startLedger = cursor.lastLedger + 1;
    } else {
      const latest = await this.sorobanService.getLatestLedger();
      startLedger = latest.sequence;
      this.logger.log(
        `[event-ingestion] no cursor found; starting from latest ledger ${startLedger}`,
      );
    }

    const response = await this.sorobanService.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [settlementContractId] }],
    });

    // Track cursor-lag metric
    const lastEventLedger =
      response.events.length > 0
        ? response.events[response.events.length - 1].ledger
        : startLedger;
    const lag = Math.max(0, response.latestLedger - lastEventLedger);
    this.metrics.ingestionCursorLag.set(lag);

    for (const event of response.events) {
      await this.ingestWithPersistence(event, network, settlementContractId);
    }

    // Advance the cursor to the latest polled ledger
    await this.prisma.ingestionCursor.upsert({
      where: { ingestion_cursor_uniq: { network, contractId: settlementContractId } },
      create: {
        network,
        contractId: settlementContractId,
        lastLedger: response.latestLedger,
        lastEventIdx: 0,
      },
      update: { lastLedger: response.latestLedger },
    });
  }

  /**
   * Ingests a single event with full DB persistence:
   * - Checks processed_events for deduplication
   * - Applies the event and records processed_events in one DB transaction
   * - Dead-letters after MAX_DEAD_LETTER_ATTEMPTS failures
   */
  async ingestWithPersistence(
    event: SorobanRpc.Api.EventResponse,
    network: string,
    contractId: string,
  ): Promise<boolean> {
    const ledger = event.ledger;
    const eventIndex = parseEventIndex(event.id);

    // Quick dedup check before entering the transaction
    const existing = await this.prisma.processedEvent.findFirst({
      where: { ledger, eventIndex, contractId, network },
    });
    if (existing) {
      this.duplicateCount++;
      return false;
    }

    let attempts = 0;
    while (attempts < MAX_DEAD_LETTER_ATTEMPTS) {
      attempts++;
      try {
        await this.prisma.$transaction(async (tx) => {
          // Double-check inside the transaction (concurrent-replica guard)
          const alreadyDone = await tx.processedEvent.findFirst({
            where: { ledger, eventIndex, contractId, network },
          });
          if (alreadyDone) return;

          // Apply the event (synchronous processing)
          this.processEvent(event);

          // Record dedup entry atomically with the event application
          await tx.processedEvent.create({
            data: { ledger, eventIndex, contractId, network },
          });
        });

        this.processedCount++;
        return true;
      } catch (err) {
        this.logger.warn(
          `[event-ingestion] event ${ledger}:${eventIndex} apply attempt ${attempts} failed: ${(err as Error).message}`,
        );
        if (attempts >= MAX_DEAD_LETTER_ATTEMPTS) {
          await this.deadLetter(
            event,
            network,
            contractId,
            attempts,
            (err as Error).message,
          );
          return false;
        }
        // Brief pause before retry
        await new Promise((resolve) => setTimeout(resolve, 200 * attempts));
      }
    }

    return false;
  }

  private readonly seenKeys = new Set<string>();

  /**
   * Legacy synchronous ingest path — kept for backward compatibility with
   * existing unit tests that don't inject PrismaService. Uses the in-memory
   * seenKeys set for deduplication (bounded, loses state on restart).
   */
  ingest(event: SorobanRpc.Api.EventResponse): boolean {
    const dedupeKey = buildDedupeKey({
      ledgerSequence: event.ledger,
      eventIndex: parseEventIndex(event.id),
    });
    if (this.seenKeys.has(dedupeKey)) {
      this.duplicateCount++;
      return false;
    }
    this.seenKeys.add(dedupeKey);
    this.processEvent(event);
    this.processedCount++;
    return true;
  }

  private async deadLetter(
    event: SorobanRpc.Api.EventResponse,
    network: string,
    contractId: string,
    attempts: number,
    lastError: string,
  ): Promise<void> {
    const ledger = event.ledger;
    const eventIndex = parseEventIndex(event.id);
    await this.prisma.deadLetterEvent.create({
      data: {
        ledger,
        eventIndex,
        contractId,
        network,
        eventPayload: event as unknown as Parameters<typeof this.prisma.deadLetterEvent.create>[0]["data"]["eventPayload"],
        lastError,
        attempts,
      },
    });
    this.metrics.ingestionDeadLetterTotal.inc();
    this.logger.error(
      `[event-ingestion] event ${ledger}:${eventIndex} dead-lettered after ${attempts} attempts: ${lastError}`,
    );
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
        this.logger.error(
          `[event-ingestion] solver_slashed reconciliation failed at ledger=${event.ledger}: ${(err as Error).message}`,
        ),
      );
    }

    const intentId = typeof topic[1] === "string" ? topic[1] : undefined;
    if (intentId) {
      this.lastIntentUpdateById.set(intentId, Math.floor(Date.now() / 1000));
    }
  }

  private handleIntentFilled(
    event: SorobanRpc.Api.EventResponse,
    topic: unknown[],
  ): void {
    this.logger.log(
      `[event-ingestion] intent_filled event at ledger=${event.ledger} txHash=${event.txHash} topic=${JSON.stringify(topic)}`,
    );
  }

  private async reconcileStaleIntents(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const [intentId, lastUpdated] of this.lastIntentUpdateById.entries()) {
      if (now - lastUpdated <= STALE_INTENT_THRESHOLD_SECONDS) continue;

      this.logger.warn(
        `[event-ingestion] stale intent state detected for intent=${intentId} lastUpdatedSecondsAgo=${now - lastUpdated}; polling chain for reconciliation`,
      );

      const settlementContractId = this.configService.get(
        "stellar.settlementContractId",
        { infer: true },
      );
      if (!settlementContractId) continue;

      const latestLedger = await this.sorobanService.getLatestLedger();
      await this.sorobanService.getEvents({
        startLedger: Math.max(1, latestLedger.sequence - 1),
        filters: [{ type: "contract", contractIds: [settlementContractId] }],
      });

      this.lastIntentUpdateById.set(intentId, Math.floor(Date.now() / 1000));
    }
  }

  /**
   * Handles a solver_slashed event emitted by the Soroban solver-registry
   * contract once a slash transaction is confirmed on-chain.
   *
   * Expected topic layout (positions 1+ after the event name at position 0):
   *   topic[1] — solver address (string)
   *   topic[2] — intentId (string)
   *   topic[3] — slash amount (string or bigint)
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
      rootLogger.warn(
        `[event-ingestion] solver_slashed event at ledger=${event.ledger} has unexpected topic shape; skipping reconciliation`,
        { solverAddress, intentId, slashAmount, rawTopic: topic },
      );
      return;
    }

    rootLogger.info(
      `[event-ingestion] solver_slashed confirmed: solver=${solverAddress} intentId=${intentId} slashAmount=${slashAmount} ledger=${event.ledger}`,
    );

    await this.solversService.confirmPenalty(intentId, slashAmount);
  }
}
