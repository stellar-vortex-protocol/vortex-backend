/**
 * SolverRegistryEventsService (issue #399)
 * ──────────────────────────────────────────
 * Ingests events emitted by the on-chain solver-registry contract and projects
 * them into the Postgres `solvers` table, making the contract the single source
 * of truth for solver registration, bond balances, and active status.
 *
 * Ingested events
 * ───────────────
 * SolverRegistered  — upsert solver with source="chain", set initial bond
 * BondDeposited     — increase bondAmount, mark active
 * BondWithdrawn     — decrease bondAmount (clamp to 0)
 * SolverSlashed     — decrease bondAmount by slash amount
 * SolverDeactivated — set isActive=false
 *
 * Idempotency / out-of-order handling
 * ─────────────────────────────────────
 * Every projection handler guards on chainUpdatedLedger: events whose ledger
 * sequence is ≤ the already-stored chainUpdatedLedger are silently skipped.
 * This makes the projection replayable — applying the same event stream twice
 * yields the same table state.
 *
 * Unknown solvers
 * ───────────────
 * Events for addresses not yet in the database create a new record with
 * source="chain" and sensible defaults (bond from event, isActive inferred
 * from event type).  This covers the case where the backend is deployed after
 * the contract already has registrations.
 *
 * Contract topic layout (positions after event name at topic[0])
 * ───────────────────────────────────────────────────────────────
 * SolverRegistered:  topic[1]=address, topic[2]=bondAmount
 * BondDeposited:     topic[1]=address, topic[2]=amount
 * BondWithdrawn:     topic[1]=address, topic[2]=amount
 * SolverSlashed:     topic[1]=address, topic[2]=intentId, topic[3]=slashAmount
 * SolverDeactivated: topic[1]=address
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../../config/configuration";
import { SorobanService } from "../soroban.service";
import { SolversService } from "../../solvers/solvers.service";
import { IntentsGateway } from "../../intents/intents.gateway";
import { MetricsService } from "../../metrics/metrics.service";
import { SolverBondService } from "../solver-bond.service";
import { logger as appLogger } from "../../common/logger";
import { parseEventIndex, buildDedupeKey } from "../event-ingestion.service";

const POLL_INTERVAL_MS = 10_000;
const MAX_TRACKED_KEYS = 10_000;

@Injectable()
export class SolverRegistryEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SolverRegistryEventsService.name);
  private interval?: NodeJS.Timeout;
  private nextStartLedger?: number;
  private readonly seenKeys = new Set<string>();

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly solversService: SolversService,
    @Optional() private readonly gateway?: IntentsGateway,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly solverBondService?: SolverBondService,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.error(
          `[solver-registry-events] poll failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async poll(): Promise<void> {
    const contractId = this.configService.get("stellar.solverRegistryContractId", { infer: true });
    if (!contractId) return;

    let startLedger = this.nextStartLedger;
    if (startLedger === undefined) {
      const latest = await this.sorobanService.getLatestLedger();
      startLedger = latest.sequence;
    }

    const response = await this.sorobanService.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
    });

    for (const event of response.events) {
      await this.ingestEvent(event);
    }

    this.nextStartLedger = response.latestLedger + 1;
  }

  /**
   * Ingest a single raw Soroban event from the solver-registry contract.
   * Deduplicates by ledger:eventIndex so replaying is safe.
   */
  async ingestEvent(event: SorobanRpc.Api.EventResponse): Promise<void> {
    const dedupeKey = buildDedupeKey({
      ledgerSequence: event.ledger,
      eventIndex: parseEventIndex(event.id),
    });

    if (this.seenKeys.has(dedupeKey)) return;
    this.markSeen(dedupeKey);

    const topic = event.topic.map((scVal) => {
      try { return scValToNative(scVal); } catch { return undefined; }
    });

    const eventName = typeof topic[0] === "string" ? topic[0] : undefined;
    if (!eventName) return;

    if (["SolverRegistered", "BondUpdated", "BondDeposited", "BondWithdrawn", "SolverSlashed", "SolverDeactivated"].includes(eventName)) {
      const address = topic[1];
      if (typeof address === "string") this.solverBondService?.invalidate(address);
      else this.solverBondService?.invalidateAll();
    }

    try {
      switch (eventName) {
        case "SolverRegistered":
          await this.handleSolverRegistered(event.ledger, topic);
          break;
        case "BondDeposited":
          await this.handleBondDeposited(event.ledger, topic);
          break;
        case "BondWithdrawn":
          await this.handleBondWithdrawn(event.ledger, topic);
          break;
        case "SolverSlashed":
          await this.handleSolverSlashed(event.ledger, topic);
          break;
        case "SolverDeactivated":
          await this.handleSolverDeactivated(event.ledger, topic);
          break;
        default:
          // Unrecognised event — ignore silently.
          return;
      }

      try { this.metricsService?.incSolverRegistryEvent(eventName); } catch { /* noop */ }
    } catch (err) {
      this.logger.error(
        `[solver-registry-events] failed to project event ${eventName} at ledger=${event.ledger}: ${(err as Error).message}`,
      );
    }
  }

  // ── Projection handlers ────────────────────────────────────────────────────

  /**
   * SolverRegistered: create or refresh the solver record.
   * topic[1]=address, topic[2]=initialBond
   */
  private async handleSolverRegistered(ledger: number, topic: unknown[]): Promise<void> {
    const address = this.requireString(topic[1], "SolverRegistered:address");
    const bond = this.toAmountString(topic[2], "0");

    const existing = await this.solversService.get(address);

    if (existing) {
      if (!this.isNewer(existing.chainUpdatedLedger, ledger)) return;
      await this.solversService.applyChainUpdate(address, {
        bondAmount: bond,
        isActive: true,
        source: "chain",
        chainUpdatedLedger: ledger,
      });
    } else {
      // Unknown solver — create a minimal record from the on-chain data.
      await this.solversService.registerFromChain({
        address,
        bondAmount: bond,
        name: address.slice(0, 12),
        isActive: true,
        supportedChains: [],
        supportedTokens: [],
        chainUpdatedLedger: ledger,
      });
    }

    appLogger.info(`[solver-registry-events] SolverRegistered: address=${address} bond=${bond} ledger=${ledger}`);
  }

  /**
   * BondDeposited: add deposit amount to existing bond.
   * topic[1]=address, topic[2]=depositAmount
   */
  private async handleBondDeposited(ledger: number, topic: unknown[]): Promise<void> {
    const address = this.requireString(topic[1], "BondDeposited:address");
    const depositAmount = this.toAmountString(topic[2], "0");

    const existing = await this.solversService.get(address);
    if (existing && !this.isNewer(existing.chainUpdatedLedger, ledger)) return;

    const currentBond = existing ? BigInt(existing.bondAmount) : 0n;
    const newBond = (currentBond + BigInt(depositAmount)).toString();

    if (existing) {
      await this.solversService.applyChainUpdate(address, {
        bondAmount: newBond,
        isActive: true,
        source: "chain",
        chainUpdatedLedger: ledger,
      });
    } else {
      await this.solversService.registerFromChain({
        address,
        bondAmount: newBond,
        name: address.slice(0, 12),
        isActive: true,
        supportedChains: [],
        supportedTokens: [],
        chainUpdatedLedger: ledger,
      });
    }

    appLogger.info(`[solver-registry-events] BondDeposited: address=${address} amount=${depositAmount} newBond=${newBond} ledger=${ledger}`);

    // Notify live WS connections about updated bond capacity (issue #436).
    try { await this.gateway?.updateSolverPredicate(address); } catch { /* noop */ }
  }

  /**
   * BondWithdrawn: subtract withdrawn amount from bond (clamp to 0).
   * topic[1]=address, topic[2]=withdrawAmount
   */
  private async handleBondWithdrawn(ledger: number, topic: unknown[]): Promise<void> {
    const address = this.requireString(topic[1], "BondWithdrawn:address");
    const withdrawAmount = this.toAmountString(topic[2], "0");

    const existing = await this.solversService.get(address);
    if (!existing) return; // Can't withdraw from an unknown solver.
    if (!this.isNewer(existing.chainUpdatedLedger, ledger)) return;

    const current = BigInt(existing.bondAmount);
    const withdraw = BigInt(withdrawAmount);
    const newBond = (current > withdraw ? current - withdraw : 0n).toString();

    await this.solversService.applyChainUpdate(address, {
      bondAmount: newBond,
      source: "chain",
      chainUpdatedLedger: ledger,
    });

    appLogger.info(`[solver-registry-events] BondWithdrawn: address=${address} amount=${withdrawAmount} newBond=${newBond} ledger=${ledger}`);

    try { await this.gateway?.updateSolverPredicate(address); } catch { /* noop */ }
  }

  /**
   * SolverSlashed: reduce bond by slash amount; delegates to SolversService
   * confirmPenalty for in-flight penalty reconciliation.
   * topic[1]=address, topic[2]=intentId, topic[3]=slashAmount
   */
  private async handleSolverSlashed(ledger: number, topic: unknown[]): Promise<void> {
    const address = this.requireString(topic[1], "SolverSlashed:address");
    const intentId = this.requireString(topic[2], "SolverSlashed:intentId");
    const slashAmount = this.toAmountString(topic[3], "0");

    const existing = await this.solversService.get(address);
    if (existing && !this.isNewer(existing.chainUpdatedLedger, ledger)) return;

    // Reconcile via confirmPenalty (updates bondAmount + marks penalty confirmed).
    await this.solversService.confirmPenalty(intentId, slashAmount);

    // Also stamp chainUpdatedLedger so future events are ordered correctly.
    if (existing) {
      await this.solversService.applyChainUpdate(address, {
        source: "chain",
        chainUpdatedLedger: ledger,
      });
    }

    appLogger.info(`[solver-registry-events] SolverSlashed: address=${address} intentId=${intentId} slashAmount=${slashAmount} ledger=${ledger}`);

    try { await this.gateway?.updateSolverPredicate(address); } catch { /* noop */ }
  }

  /**
   * SolverDeactivated: mark solver inactive.
   * topic[1]=address
   */
  private async handleSolverDeactivated(ledger: number, topic: unknown[]): Promise<void> {
    const address = this.requireString(topic[1], "SolverDeactivated:address");

    const existing = await this.solversService.get(address);
    if (existing && !this.isNewer(existing.chainUpdatedLedger, ledger)) return;

    if (existing) {
      await this.solversService.applyChainUpdate(address, {
        isActive: false,
        source: "chain",
        chainUpdatedLedger: ledger,
      });
    }

    appLogger.info(`[solver-registry-events] SolverDeactivated: address=${address} ledger=${ledger}`);

    // Disconnect stale WS capability predicate (bond may now be zero / inactive).
    try { await this.gateway?.updateSolverPredicate(address); } catch { /* noop */ }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /** True when `eventLedger` is strictly newer than the last applied ledger. */
  private isNewer(chainUpdatedLedger: number | null | undefined, eventLedger: number): boolean {
    if (chainUpdatedLedger == null) return true;
    return eventLedger > chainUpdatedLedger;
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new Error(`SolverRegistryEventsService: expected string for field ${field}, got ${JSON.stringify(value)}`);
  }

  private toAmountString(value: unknown, fallback: string): string {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value).toString();
    return fallback;
  }

  private markSeen(key: string): void {
    this.seenKeys.add(key);
    if (this.seenKeys.size > MAX_TRACKED_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest !== undefined) this.seenKeys.delete(oldest);
    }
  }
}
