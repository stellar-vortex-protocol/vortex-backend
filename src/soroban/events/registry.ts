/**
 * Decoder registry — the single entry point for all event decoding.
 *
 * Wraps the low-level `decodeEvent` function with:
 *   - Unknown-topic counting/logging (not throwing)
 *   - Dead-letter routing for known-topic decode failures
 *   - Per-topic counters accessible for metrics/tests
 *
 * Exported for reuse by EventIngestionService, BackfillService, and the
 * reconciliation backfill script.
 *
 * @module soroban/events/registry
 */

import { Logger } from "@nestjs/common";
import type { SorobanRpc } from "@stellar/stellar-sdk";
import { decodeEvent, type DecodedEvent, type DecodeResult } from "./decoders";

export interface RegistryStats {
  processed: number;
  unknownTopic: number;
  decodeErrors: number;
  deadLettered: number;
}

export interface DeadLetterEntry {
  eventId: string;
  ledger: number;
  txHash: string;
  rawTopic: string;
  error: string;
  rawXdr: string;
  occurredAt: Date;
}

/**
 * Callback invoked when a known-topic event fails schema validation and must
 * be written to the dead-letter store. Implementations are responsible for
 * persisting the entry (e.g. via PrismaService).
 */
export type DeadLetterSink = (entry: DeadLetterEntry) => Promise<void>;

/**
 * Callback invoked on every successfully decoded event.
 */
export type EventHandler = (event: DecodedEvent) => Promise<void>;

/**
 * Options for creating a decoder registry instance.
 */
export interface RegistryOptions {
  /** Called for each successfully decoded event. */
  onEvent: EventHandler;
  /** Called when a decode fails for a known topic. */
  onDeadLetter?: DeadLetterSink;
  /** Logger instance (defaults to a new NestJS Logger). */
  logger?: Logger;
}

/**
 * EventDecoderRegistry processes raw Soroban events through the versioned
 * decoder pipeline and routes outcomes to the appropriate handler.
 *
 * Thread-safety: all operations are synchronous aside from the user-supplied
 * `onEvent` and `onDeadLetter` callbacks; NestJS runs in a single-threaded
 * event loop so internal counters need no locking.
 */
export class EventDecoderRegistry {
  private readonly logger: Logger;
  private readonly onEvent: EventHandler;
  private readonly onDeadLetter: DeadLetterSink;

  private readonly stats: RegistryStats = {
    processed: 0,
    unknownTopic: 0,
    decodeErrors: 0,
    deadLettered: 0,
  };

  /** Per-topic unknown counts for alerting. */
  private readonly unknownTopicCounts = new Map<string, number>();

  constructor(opts: RegistryOptions) {
    this.logger = opts.logger ?? new Logger(EventDecoderRegistry.name);
    this.onEvent = opts.onEvent;
    this.onDeadLetter = opts.onDeadLetter ?? (async () => { /* no-op */ });
  }

  /**
   * Process a single raw Soroban event through the decode pipeline.
   *
   * Never throws — all error paths are handled internally.
   */
  async process(event: SorobanRpc.Api.EventResponse): Promise<DecodeResult> {
    const result = decodeEvent(event);

    if (result.ok) {
      this.stats.processed++;
      try {
        await this.onEvent(result.event);
      } catch (err) {
        // Handler errors are logged but do not fail the ingestion loop.
        this.logger.error(
          `[registry] event handler failed for type=${result.event.type} ` +
          `ledger=${result.event.ledger}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return result;
    }

    if (result.reason === "unknown_topic") {
      this.stats.unknownTopic++;
      const count = (this.unknownTopicCounts.get(result.rawTopic) ?? 0) + 1;
      this.unknownTopicCounts.set(result.rawTopic, count);
      this.logger.verbose(
        `[registry] unknown topic="${result.rawTopic}" count=${count} ` +
        `ledger=${event.ledger} txHash=${event.txHash}`,
      );
      return result;
    }

    // decode_error — route to dead-letter
    this.stats.decodeErrors++;
    this.stats.deadLettered++;
    const entry: DeadLetterEntry = {
      eventId: event.id,
      ledger: event.ledger,
      txHash: event.txHash,
      rawTopic: result.rawTopic,
      error: result.error,
      rawXdr: JSON.stringify(event.topic.map((t) => t.toXDR("base64"))),
      occurredAt: new Date(),
    };

    this.logger.warn(
      `[registry] dead-letter: topic="${result.rawTopic}" ledger=${event.ledger} ` +
      `txHash=${event.txHash} error="${result.error}"`,
    );

    try {
      await this.onDeadLetter(entry);
    } catch (err) {
      this.logger.error(
        `[registry] dead-letter sink failed for topic="${result.rawTopic}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }

  /**
   * Process a batch of events in order. Returns counts of ok/error outcomes.
   */
  async processBatch(
    events: SorobanRpc.Api.EventResponse[],
  ): Promise<{ ok: number; errors: number }> {
    let ok = 0;
    let errors = 0;
    for (const ev of events) {
      const r = await this.process(ev);
      if (r.ok) ok++;
      else errors++;
    }
    return { ok, errors };
  }

  /** Current aggregate stats since this instance was created. */
  getStats(): Readonly<RegistryStats> {
    return { ...this.stats };
  }

  /** Unknown-topic frequency map for observability. */
  getUnknownTopicCounts(): ReadonlyMap<string, number> {
    return this.unknownTopicCounts;
  }
}
