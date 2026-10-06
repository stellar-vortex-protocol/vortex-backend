/**
 * Human-readable report formatting for the simulation harness (issue #452).
 *
 * Pure string building over {@link SimReport} / {@link SweepReport} — no
 * clock, no I/O — so formatted output is deterministic and diffable.
 */
import type { SimReport } from "./types";
import type { SweepReport } from "./sweep";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Format a single replay as an aligned plain-text report covering PnL,
 * fill-rate and slash-risk (the three views the issue calls for).
 */
export function formatReport(report: SimReport): string {
  const t = report.totals;
  const p = report.params;
  const lines = [
    `Strategy:           ${report.strategy}`,
    `Params:            seed=${p.seed} feeBps=${p.feeBps} fillWindowSec=${p.fillWindowSec} minMarginBps=${p.minMarginBps} slashPenaltyUsd=${p.slashPenaltyUsd} gasUsdPerFill=${p.gasUsdPerFill}`,
    `Events:            ${num(t.events)} (${num(t.intentEvents)} intents, ${num(t.quoteRequests)} quote requests)`,
    `Quotes:            ${num(t.quotesSubmitted)} submitted, ${num(t.quotesDeclined)} declined`,
    `Filled:            ${num(t.filled)}  fill rate ${pct(t.fillRate)}  capture ${pct(t.captureRate)}`,
    `Failed fills:      ${num(t.failedFills)} (late ${num(t.failedLate)}, below min ${num(t.failedBelowMin)})`,
    `Slash risk:        ${num(t.slashEvents)} event(s), penalty ${usd(t.slashPenaltyUsd)}`,
    `Volume:            ${usd(t.volumeUsd)}`,
    `Fees paid:         ${usd(t.feesPaidUsd)}  gas: ${usd(t.gasPaidUsd)}`,
    `PnL:               ${usd(t.pnlUsd)}  (unpriced fills: ${num(t.unknownPriceFills)})`,
    `Avg fill latency:  ${num(Math.round(t.avgFillLatencyMs))} ms`,
  ];
  return lines.join("\n");
}

/**
 * Format a sweep as a GitHub-flavored Markdown table, one row per grid
 * cell, ordered window-major then fee bps.
 */
export function formatSweep(sweep: SweepReport): string {
  const lines = [
    `Strategy: ${sweep.strategy} — seed ${sweep.seed}`,
    "",
    "| fill window (s) | fee bps | fill rate | capture | filled | slashes | PnL (USD) | fees (USD) | volume (USD) |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of sweep.rows) {
    const t = row.report.totals;
    lines.push(
      `| ${row.fillWindowSec} | ${row.feeBps} | ${pct(t.fillRate)} | ${pct(t.captureRate)} | ` +
        `${num(t.filled)} | ${num(t.slashEvents)} | ${t.pnlUsd.toFixed(2)} | ` +
        `${t.feesPaidUsd.toFixed(2)} | ${t.volumeUsd.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}
