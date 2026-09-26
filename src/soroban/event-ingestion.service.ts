/**
 * Live event ingestion service.
 *
 * Polls the Soroban RPC for settlement and solver-registry contract events,
 * routes each through the versioned decoder registry, and persists an
 * idempotency record to `processed_events`.
 *
 * The reconcileStaleIntents loop has been replaced by ReconcilerService (#392),
 * which reads intent state directly from the contract instead of re-polling
 * the event log.
 *
 * @module soroban/event-ingestion.service
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { SorobanService } from "./soroban.service";
import { SolversService } from "../solvers/solvers.service";
import { EventDecoderRegistry, type DeadLetterEntry } from "./events/registry";
import type { DecodedEvent } from "./events/decoders";
import { ReconcilerService } from "./reconciler.service";
import { logger } from "../common/logger";

const POLL_INTERVAL_MS = 10_000;
const RECONCILE_INTERVAL_MS = 60_000;

// Bound the in-memory dedupe set so long-lived processes don't leak memory.
const MAX_TRACKED_KEYS = 10_000;

export interface DedupeKeyParts {
  ledgerSequence: number;
  eventIndex: number;
}

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
  private readonly seenKeys = new Set<string>();
  private nextStartLedger?: number;

  processedCount = 0;
  duplicateCount = 0;

  /** Registry wired with domain-level event handlers. */
  private readonly registry: EventDecoderRegistry;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly solversService: SolversService,
    private readonly prisma: PrismaService,
    private readonly reconcilerService: ReconcilerService,
  ) {
    this.registry = new EventDecoderRegistry({
      onEvent: (event) => this.handleDecodedEvent(event),
      onDeadLetter: (entry) => this.persistDeadLetter(entry),
      logger: this.logger,
    });
  }

  onModuleInit() {
    this.interval = setInterval(() => {
      this.poll().catch((err) =>
        logger.error(
          `[event-ingestion] poll failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, POLL_INTERVAL_MS);

    this.reconcileInterval = setInterval(() => {
      this.reconcilerService.reconcile().catch((err) => {
        logger.error(
          `[event-ingestion] reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, RECONCILE_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
  }

  async poll(): Promise<void> {
    const settlementContractId = this.configService.get(
      "stellar.settlementContractId",
      { infer: true },
    );
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
      await this.ingest(event);
    }

    this.nextStartLedger = response.latestLedger + 1;
  }

  /**
   * Process a single raw Soroban event.
   * Skips events already seen at this ledger+index (dedup) and persists an
   * idempotency record to `processed_events` on success.
   */
  async ingest(event: SorobanRpc.Api.EventResponse): Promise<boolean> {
    const dedupeKey = buildDedupeKey({
      ledgerSequence: event.ledger,
      eventIndex: parseEventIndex(event.id),
    });

    if (this.seenKeys.has(dedupeKey)) {
      this.duplicateCount++;
      return false;
    }

    // Idempotency check against persistent store
    const eventIndex = parseEventIndex(event.id);
    try {
      const existing = await this.prisma.processedEvent.findUnique({
        where: {
          processed_events_ledger_idx_key: { ledger: event.ledger, eventIndex },
        },
      });
      if (existing) {
        this.duplicateCount++;
        this.markSeen(dedupeKey);
        return false;
      }
    } catch {
      // DB unavailable — fall through to in-memory dedup; non-fatal
    }

    this.markSeen(dedupeKey);

    await this.registry.process(event);
    this.processedCount++;

    // Persist idempotency record (best-effort; unique constraint handles races)
    try {
      const topic = this.extractTopicName(event);
      await this.prisma.processedEvent.create({
        data: {
          eventId: event.id,
          ledger: event.ledger,
          eventIndex,
          contractId: (event as unknown as { contractId?: string }).contractId ?? "",
          topic,
          txHash: event.txHash,
        },
      });
    } catch {
      // Unique constraint violation = concurrent duplicate. Safe to ignore.
    }

    return true;
  }

  private markSeen(dedupeKey: string) {
    this.seenKeys.add(dedupeKey);
    if (this.seenKeys.size > MAX_TRACKED_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest !== undefined) this.seenKeys.delete(oldest);
    }
  }

  // ── Decoded-event handlers ─────────────────────────────────────────────────

  private async handleDecodedEvent(event: DecodedEvent): Promise<void> {
    // Notify reconciler so it doesn't re-check recently-ingested intents
    if ("intentId" in event.payload) {
      this.reconcilerService.markIntentUpdated(
        (event.payload as { intentId: string }).intentId,
      );
    }

    switch (event.type) {
      case "intent_filled":
        this.logger.log(
          `[event-ingestion] intent_filled intent=${event.payload.intentId} ` +
          `solver=${event.payload.solver} fillAmount=${event.payload.fillAmount} ` +
          `ledger=${event.ledger}`,
        );
        // Full state-transition wiring is landed via on-chain intent registration
        // (issue #22); the decoded payload is available here for when that lands.
        break;

      case "intent_registered":
        this.logger.log(
          `[event-ingestion] intent_registered intent=${event.payload.intentId} ` +
          `user=${event.payload.user} ledger=${event.ledger}`,
        );
        break;

      case "intent_accepted":
        this.logger.log(
          `[event-ingestion] intent_accepted intent=${event.payload.intentId} ` +
          `solver=${event.payload.solver} ledger=${event.ledger}`,
        );
        break;

      case "intent_cancelled":
        this.logger.log(
          `[event-ingestion] intent_cancelled intent=${event.payload.intentId} ` +
          `cancelledBy=${event.payload.cancelledBy} ledger=${event.ledger}`,
        );
        break;

      case "solver_slashed":
        await this.handleSolverSlashed(event);
        break;

      case "bond_updated":
        this.logger.log(
          `[event-ingestion] bond_updated solver=${event.payload.solver} ` +
          `newBondAmount=${event.payload.newBondAmount} delta=${event.payload.delta} ` +
          `ledger=${event.ledger}`,
        );
        break;

      default:
        this.logger.verbose(
          `[event-ingestion] unhandled event type: ${(event as DecodedEvent).type}`,
        );
    }
  }

  private async handleSolverSlashed(
    event: Extract<DecodedEvent, { type: "solver_slashed" }>,
  ): Promise<void> {
    const { solver, intentId, slashAmount } = event.payload;
    this.logger.log(
      `[event-ingestion] solver_slashed confirmed: solver=${solver} ` +
      `intentId=${intentId} slashAmount=${slashAmount} ledger=${event.ledger}`,
    );
    await this.solversService.confirmPenalty(intentId, String(slashAmount));
  }

  private async persistDeadLetter(entry: DeadLetterEntry): Promise<void> {
    try {
      await this.prisma.deadLetterEvent.create({
        data: {
          eventId: entry.eventId,
          ledger: entry.ledger,
          txHash: entry.txHash,
          rawTopic: entry.rawTopic,
          error: entry.error,
          rawXdr: entry.rawXdr,
          occurredAt: entry.occurredAt,
        },
      });
    } catch (err) {
      this.logger.error(
        `[event-ingestion] failed to persist dead-letter for event=${entry.eventId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private extractTopicName(event: SorobanRpc.Api.EventResponse): string {
    try {
      return String(scValToNative(event.topic[0]) ?? "unknown");
    } catch {
      return "unknown";
    }
  }
}
