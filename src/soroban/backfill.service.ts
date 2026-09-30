/**
 * Ledger-gap detection and historical backfill for Soroban contract events.
 *
 * Architecture
 * ────────────
 * An `EventSource` interface abstracts over RPC vs. archival providers so the
 * same decoder+handler pipeline can process both live and historical data.
 *
 * `BackfillService` implements the resumable, rate-limited page-fetch loop and
 * records per-ledger progress in `processed_events` (idempotent upsert), so a
 * crash mid-backfill can be resumed from the last committed ledger.
 *
 * Live ingestion does NOT pause during a backfill — both paths write through
 * the same idempotency table, so overlap is harmless.
 *
 * @see docs/runbooks/event-backfill.md
 * @module soroban/backfill.service
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { EventDecoderRegistry, type DeadLetterEntry } from "./events/registry";
import { SorobanService } from "./soroban.service";

// ─── EventSource interface ────────────────────────────────────────────────────

export interface LedgerRange {
  fromLedger: number;
  toLedger: number;
}

export interface EventPage {
  events: SorobanRpc.Api.EventResponse[];
  /** Ledger sequence of the last event in this page (for cursor tracking). */
  lastLedger: number;
  /** True when there are no more pages to fetch. */
  done: boolean;
}

/**
 * Abstraction over a Soroban event source.
 *
 * - `RpcEventSource` — uses the live Soroban RPC (limited retention window).
 * - `ArchivalEventSource` — pages through an archival provider for deep history.
 */
export interface EventSource {
  readonly name: string;
  /**
   * Fetch a page of contract events starting at `startLedger`.
   * Implementations must be idempotent (safe to call multiple times for the
   * same range due to backfill restarts).
   */
  fetchPage(contractId: string, startLedger: number, pageSize: number): Promise<EventPage>;
}

// ─── RpcEventSource ──────────────────────────────────────────────────────────

/**
 * EventSource backed by the live Soroban RPC endpoint.
 * Suitable for the standard retention window (~17-day rolling on Futurenet,
 * varies by provider on Testnet/Mainnet).
 */
export class RpcEventSource implements EventSource {
  readonly name = "rpc";

  constructor(private readonly server: SorobanRpc.Server) {}

  async fetchPage(
    contractId: string,
    startLedger: number,
    pageSize: number,
  ): Promise<EventPage> {
    const response = await this.server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: pageSize,
    });

    const events = response.events;
    const lastLedger =
      events.length > 0 ? events[events.length - 1].ledger : startLedger;

    return {
      events,
      lastLedger,
      // RPC returns fewer than pageSize events when we're at the tip
      done: events.length < pageSize,
    };
  }
}

// ─── ArchivalEventSource ─────────────────────────────────────────────────────

/**
 * EventSource backed by an archival provider (Horizon, Galexie, or a
 * history-archive-backed RPC). The URL is configured via
 * `ARCHIVAL_RPC_URL` and must expose the same `getEvents` JSON-RPC surface as
 * a standard Soroban RPC endpoint.
 */
export class ArchivalEventSource implements EventSource {
  readonly name = "archival";
  private readonly server: SorobanRpc.Server;

  constructor(archivalUrl: string) {
    this.server = new SorobanRpc.Server(archivalUrl, {
      allowHttp: archivalUrl.startsWith("http://"),
    });
  }

  async fetchPage(
    contractId: string,
    startLedger: number,
    pageSize: number,
  ): Promise<EventPage> {
    const response = await this.server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: pageSize,
    });

    const events = response.events;
    const lastLedger =
      events.length > 0 ? events[events.length - 1].ledger : startLedger;

    return {
      events,
      lastLedger,
      done: events.length < pageSize,
    };
  }
}

// ─── GapDetector ─────────────────────────────────────────────────────────────

export interface GapReport {
  /** Current ingestion cursor (nextStartLedger). */
  cursorLedger: number;
  /** Oldest ledger the RPC still has in its retention window. */
  oldestLedger: number;
  /** Latest ledger from the RPC. */
  latestLedger: number;
  /** True when cursor < oldestLedger — the RPC can no longer serve those events. */
  hasGap: boolean;
  /** Number of ledgers behind the RPC window. Only meaningful when hasGap=true. */
  gapSize: number;
}

/**
 * Compares the current ingestion cursor against the RPC retention window.
 * Returns a gap report indicating whether an archival backfill is needed.
 */
export async function detectGap(
  server: SorobanRpc.Server,
  cursorLedger: number,
): Promise<GapReport> {
  const [latestResp, oldestResp] = await Promise.all([
    server.getLatestLedger(),
    server.getHealth(),
  ]);

  const latestLedger = latestResp.sequence;
  // `oldestLedger` is exposed in the health response in recent RPC versions;
  // fall back to the network minimum when not present.
  const oldestLedger =
    (oldestResp as unknown as Record<string, unknown>)["oldestLedger"] !== undefined
      ? Number((oldestResp as unknown as Record<string, number>)["oldestLedger"])
      : latestLedger - 17_280; // ~17 k ledgers ≈ 1 day @5 s/ledger

  const hasGap = cursorLedger < oldestLedger;
  const gapSize = hasGap ? oldestLedger - cursorLedger : 0;

  return { cursorLedger, oldestLedger, latestLedger, hasGap, gapSize };
}

// ─── BackfillService ─────────────────────────────────────────────────────────

export interface BackfillOptions {
  /** First ledger to backfill (inclusive). */
  fromLedger: number;
  /** Last ledger to backfill (inclusive). */
  toLedger: number;
  /** Events per page fetch. Defaults to 200. */
  pageSize?: number;
  /**
   * Milliseconds to sleep between page fetches to avoid hammering the provider.
   * Defaults to 250 ms.
   */
  rateLimitMs?: number;
  /** Override the default EventSource (useful in tests). */
  source?: EventSource;
}

export interface BackfillResult {
  fromLedger: number;
  toLedger: number;
  ledgersProcessed: number;
  eventsProcessed: number;
  decodeErrors: number;
  durationMs: number;
}

/**
 * Resumable, rate-limited backfill runner.
 *
 * Usage:
 *   await backfillService.run({ fromLedger: 1_000_000, toLedger: 1_100_000 });
 *
 * Progress is persisted to `processed_events` so a crash can be resumed:
 *   await backfillService.resume({ fromLedger: 1_000_000, toLedger: 1_100_000 });
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  /** Tracks an active backfill so concurrent runs are rejected. */
  private runningBackfill: Promise<BackfillResult> | null = null;

  /** Registry for this backfill service — events handled as no-ops (logging only). */
  private readonly registry: EventDecoderRegistry;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly sorobanService: SorobanService,
  ) {
    this.registry = new EventDecoderRegistry({
      onEvent: async (event) => {
        this.logger.debug(
          `[backfill] decoded event type=${event.type} ledger=${event.ledger}`,
        );
      },
      onDeadLetter: async (entry: DeadLetterEntry) => {
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
        } catch {
          // best-effort
        }
      },
      logger: this.logger,
    });
  }

  // ── Gap detection ──────────────────────────────────────────────────────────

  /**
   * Checks whether the current ingestion cursor has fallen outside the RPC
   * retention window. Callers should trigger a backfill when `hasGap=true`.
   */
  async checkGap(cursorLedger: number): Promise<GapReport> {
    // SorobanService wraps either RpcPool or single SorobanRpc.Server;
    // both expose getHealth() and getLatestLedger().
    const [latestResp, healthResp] = await Promise.all([
      this.sorobanService.getLatestLedger(),
      this.sorobanService.getHealth(),
    ]);

    const latestLedger = latestResp.sequence;
    const oldestLedger =
      (healthResp as unknown as Record<string, unknown>)["oldestLedger"] !== undefined
        ? Number((healthResp as unknown as Record<string, number>)["oldestLedger"])
        : latestLedger - 17_280;

    const hasGap = cursorLedger < oldestLedger;
    const gapSize = hasGap ? oldestLedger - cursorLedger : 0;

    return { cursorLedger, oldestLedger, latestLedger, hasGap, gapSize };
  }

  // ── Backfill execution ────────────────────────────────────────────────────

  /**
   * Run a backfill over an explicit ledger range.
   *
   * - Idempotent: already-processed events are skipped via the
   *   `processed_events` unique constraint.
   * - Rate-limited: sleeps `rateLimitMs` between page fetches.
   * - Streaming: pages are processed one at a time (no OOM from 100 k+ ledgers).
   * - Returns immediately if a backfill is already running on this instance.
   */
  async run(opts: BackfillOptions): Promise<BackfillResult> {
    if (this.runningBackfill) {
      this.logger.warn("[backfill] a backfill is already in progress — skipping");
      return this.runningBackfill;
    }
    this.runningBackfill = this.executeBackfill(opts).finally(() => {
      this.runningBackfill = null;
    });
    return this.runningBackfill;
  }

  /**
   * Resume a previously started backfill by skipping ledgers that already have
   * processed events, then running the remaining range.
   */
  async resume(opts: BackfillOptions): Promise<BackfillResult> {
    const contractId = this.configService.get("stellar.settlementContractId", { infer: true });
    if (!contractId) {
      throw new Error("SETTLEMENT_CONTRACT_ID is not configured");
    }

    const lastProcessed = await this.prisma.processedEvent.findFirst({
      where: {
        contractId,
        ledger: { gte: opts.fromLedger, lte: opts.toLedger },
      },
      orderBy: { ledger: "desc" },
    });

    const resumeFrom = lastProcessed
      ? lastProcessed.ledger + 1
      : opts.fromLedger;

    if (resumeFrom > opts.toLedger) {
      this.logger.log("[backfill] already complete — nothing to resume");
      return {
        fromLedger: opts.fromLedger,
        toLedger: opts.toLedger,
        ledgersProcessed: 0,
        eventsProcessed: 0,
        decodeErrors: 0,
        durationMs: 0,
      };
    }

    this.logger.log(
      `[backfill] resuming from ledger=${resumeFrom} (last processed=${lastProcessed?.ledger ?? "none"})`,
    );

    return this.run({ ...opts, fromLedger: resumeFrom });
  }

  /** True when a backfill is currently running on this instance. */
  get isRunning(): boolean {
    return this.runningBackfill !== null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async executeBackfill(opts: BackfillOptions): Promise<BackfillResult> {
    const {
      fromLedger,
      toLedger,
      pageSize = 200,
      rateLimitMs = 250,
    } = opts;

    const contractId = this.configService.get("stellar.settlementContractId", { infer: true });
    if (!contractId) {
      throw new Error("SETTLEMENT_CONTRACT_ID is not configured — cannot backfill");
    }

    const source: EventSource = opts.source ?? this.buildDefaultSource();

    this.logger.log(
      `[backfill] starting source=${source.name} from=${fromLedger} to=${toLedger} pageSize=${pageSize}`,
    );

    const startMs = Date.now();
    let eventsProcessed = 0;
    let decodeErrors = 0;
    let currentLedger = fromLedger;
    let ledgersProcessed = 0;

    while (currentLedger <= toLedger) {
      let page: EventPage;
      try {
        page = await source.fetchPage(contractId, currentLedger, pageSize);
      } catch (err) {
        this.logger.error(
          `[backfill] fetchPage failed at ledger=${currentLedger}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      const { ok, errors } = await this.registry.processBatch(page.events);
      eventsProcessed += ok;
      decodeErrors += errors;

      // Persist idempotency records for processed events
      for (const event of page.events) {
        const eventIndex = this.parseEventIndex(event.id);
        try {
          await this.prisma.processedEvent.upsert({
            where: {
              processed_events_ledger_idx_key: {
                ledger: event.ledger,
                eventIndex,
              },
            },
            create: {
              eventId: event.id,
              ledger: event.ledger,
              eventIndex,
              contractId: (event as unknown as { contractId?: string }).contractId ?? contractId,
              topic: this.extractTopicName(event),
              txHash: event.txHash,
            },
            update: {},
          });
        } catch {
          // Unique constraint violation = already processed. Safe to ignore.
        }
      }

      const prevLedger = currentLedger;
      currentLedger = page.done ? toLedger + 1 : page.lastLedger + 1;
      ledgersProcessed += Math.max(0, currentLedger - prevLedger);

      if (page.done || currentLedger > toLedger) break;

      if (rateLimitMs > 0) {
        await sleep(rateLimitMs);
      }
    }

    const durationMs = Date.now() - startMs;
    this.logger.log(
      `[backfill] complete source=${source.name} from=${fromLedger} to=${toLedger} ` +
      `events=${eventsProcessed} errors=${decodeErrors} duration=${durationMs}ms`,
    );

    return { fromLedger, toLedger, ledgersProcessed, eventsProcessed, decodeErrors, durationMs };
  }

  private buildDefaultSource(): EventSource {
    const archivalUrl = (process.env.ARCHIVAL_RPC_URL ?? "").trim();
    if (archivalUrl) {
      return new ArchivalEventSource(archivalUrl);
    }
    // Wrap SorobanService (which may itself be backed by the RpcPool) in a thin adapter
    const svc = this.sorobanService;
    return {
      name: "rpc",
      async fetchPage(contractId, startLedger, pageSize) {
        const response = await svc.getEvents({
          startLedger,
          filters: [{ type: "contract", contractIds: [contractId] }],
          limit: pageSize,
        });
        const events = response.events;
        const lastLedger = events.length > 0 ? events[events.length - 1].ledger : startLedger;
        return { events, lastLedger, done: events.length < pageSize };
      },
    };
  }

  private parseEventIndex(eventId: string): number {
    const parts = eventId.split("-");
    const index = Number(parts[parts.length - 1]);
    return Number.isFinite(index) ? index : 0;
  }

  private extractTopicName(event: SorobanRpc.Api.EventResponse): string {
    try {
      return String(scValToNative(event.topic[0]) ?? "unknown");
    } catch {
      return "unknown";
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
