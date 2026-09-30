#!/usr/bin/env tsx
/**
 * scripts/backfill-events.ts
 *
 * CLI script to trigger a historical event backfill for a specific ledger range.
 * Useful after a node outage that caused the ingestion cursor to fall behind the
 * RPC retention window.
 *
 * Usage:
 *   tsx scripts/backfill-events.ts --from 100000 --to 200000
 *   tsx scripts/backfill-events.ts --from 100000 --to 200000 --resume
 *   tsx scripts/backfill-events.ts --gap-check             # just report the gap
 *
 * Environment variables:
 *   DATABASE_URL          PostgreSQL connection string
 *   SOROBAN_RPC_URL       Primary Soroban RPC endpoint
 *   ARCHIVAL_RPC_URL      (optional) Archival RPC endpoint for deep history
 *   SETTLEMENT_CONTRACT_ID  Contract to backfill events for
 *
 * See docs/runbooks/event-backfill.md for the full procedure.
 */

import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import {
  detectGap,
  RpcEventSource,
  ArchivalEventSource,
  type EventSource,
} from "../src/soroban/backfill.service";
import { EventDecoderRegistry } from "../src/soroban/events/registry";

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(): {
  from: number;
  to: number;
  resume: boolean;
  gapCheck: boolean;
  pageSize: number;
  rateLimitMs: number;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  return {
    from: parseInt(get("--from") ?? "0", 10),
    to: parseInt(get("--to") ?? "0", 10),
    resume: has("--resume"),
    gapCheck: has("--gap-check"),
    pageSize: parseInt(get("--page-size") ?? "200", 10),
    rateLimitMs: parseInt(get("--rate-limit-ms") ?? "250", 10),
    dryRun: has("--dry-run"),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const archivalUrl = (process.env.ARCHIVAL_RPC_URL ?? "").trim();
  const contractId = process.env.SETTLEMENT_CONTRACT_ID ?? "";

  if (!contractId) {
    console.error("SETTLEMENT_CONTRACT_ID is not set");
    process.exit(1);
  }

  const rpcServer = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const prisma = new PrismaClient();

  // ── Gap check ────────────────────────────────────────────────────────────
  if (opts.gapCheck) {
    // We need a cursor ledger — use the most recently processed event's ledger
    const latest = await prisma.processedEvent.findFirst({
      where: { contractId },
      orderBy: { ledger: "desc" },
    });
    const cursorLedger = latest?.ledger ?? 0;
    const report = await detectGap(rpcServer, cursorLedger);

    console.log("=== Gap Detection Report ===");
    console.log(`  Cursor ledger   : ${report.cursorLedger}`);
    console.log(`  Oldest RPC ledger: ${report.oldestLedger}`);
    console.log(`  Latest ledger   : ${report.latestLedger}`);
    console.log(`  Has gap         : ${report.hasGap}`);
    if (report.hasGap) {
      console.log(`  Gap size        : ${report.gapSize} ledgers`);
      console.log("  ⚠️  Backfill required. Run with --from and --to to fill the gap.");
    } else {
      console.log("  ✓ No gap detected.");
    }
    await prisma.$disconnect();
    return;
  }

  // ── Backfill ──────────────────────────────────────────────────────────────
  if (!opts.from || !opts.to || opts.from > opts.to) {
    console.error("Usage: backfill-events.ts --from <ledger> --to <ledger> [--resume]");
    process.exit(1);
  }

  const source: EventSource = archivalUrl
    ? new ArchivalEventSource(archivalUrl)
    : new RpcEventSource(rpcServer);

  console.log(`[backfill] source=${source.name} from=${opts.from} to=${opts.to} dryRun=${opts.dryRun}`);

  // Determine start ledger (resume support)
  let startLedger = opts.from;
  if (opts.resume) {
    const lastProcessed = await prisma.processedEvent.findFirst({
      where: {
        contractId,
        ledger: { gte: opts.from, lte: opts.to },
      },
      orderBy: { ledger: "desc" },
    });
    if (lastProcessed) {
      startLedger = lastProcessed.ledger + 1;
      console.log(`[backfill] resuming from ledger=${startLedger} (last processed=${lastProcessed.ledger})`);
    }
  }

  if (startLedger > opts.to) {
    console.log("[backfill] already complete — nothing to do");
    await prisma.$disconnect();
    return;
  }

  // Registry — script-level, no domain handlers needed (counting only)
  let eventsDecoded = 0;
  let decodeErrors = 0;

  const registry = new EventDecoderRegistry({
    onEvent: async (event) => {
      eventsDecoded++;
      if (process.env.VERBOSE) {
        console.log(`  → decoded type=${event.type} ledger=${event.ledger} txHash=${event.txHash}`);
      }
    },
    onDeadLetter: async (entry) => {
      decodeErrors++;
      console.warn(`  ✗ dead-letter topic=${entry.rawTopic} ledger=${entry.ledger}: ${entry.error}`);
      if (!opts.dryRun) {
        await prisma.deadLetterEvent.create({ data: entry }).catch(() => {});
      }
    },
  });

  // Page loop
  let currentLedger = startLedger;
  let pagesProcessed = 0;
  let totalEvents = 0;
  const startMs = Date.now();

  while (currentLedger <= opts.to) {
    let page;
    try {
      page = await source.fetchPage(contractId, currentLedger, opts.pageSize);
    } catch (err) {
      console.error(`[backfill] fetchPage failed at ledger=${currentLedger}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const { ok } = await registry.processBatch(page.events);
    totalEvents += page.events.length;
    pagesProcessed++;

    if (!opts.dryRun) {
      for (const event of page.events) {
        const parts = event.id.split("-");
        const eventIndex = Number(parts[parts.length - 1]) || 0;
        try {
          await prisma.processedEvent.upsert({
            where: {
              processed_events_ledger_idx_key: { ledger: event.ledger, eventIndex },
            },
            create: {
              eventId: event.id,
              ledger: event.ledger,
              eventIndex,
              contractId: event.contractId ?? contractId,
              topic: (() => { try { return String(scValToNative(event.topic[0]) ?? "unknown"); } catch { return "unknown"; } })(),
              txHash: event.txHash,
            },
            update: {},
          });
        } catch {
          // unique constraint = already processed, safe to ignore
        }
      }
    }

    process.stdout.write(
      `\r[backfill] page=${pagesProcessed} ledger=${currentLedger} events=${totalEvents} decoded=${eventsDecoded} errors=${decodeErrors}`,
    );

    if (page.done || page.lastLedger + 1 > opts.to) break;
    currentLedger = page.lastLedger + 1;

    if (opts.rateLimitMs > 0) {
      await new Promise((r) => setTimeout(r, opts.rateLimitMs));
    }
  }

  const durationMs = Date.now() - startMs;
  console.log(`\n[backfill] complete: pages=${pagesProcessed} events=${totalEvents} decoded=${eventsDecoded} errors=${decodeErrors} duration=${durationMs}ms`);

  if (opts.dryRun) {
    console.log("[backfill] dry-run mode — no records written to database");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[backfill] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
