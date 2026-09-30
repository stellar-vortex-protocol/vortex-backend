/**
 * verify-ledger.ts
 *
 * Auditing script that independently recomputes the Drips Wave Contributor
 * Ledger from the GitHub API and diffs against the checked-in
 * docs/DRIPS_WAVE_LEDGER.md.
 *
 * Exit codes:
 *   0 — ledger matches (or --fix applied cleanly)
 *   1 — drift detected / unexpected error
 *
 * Usage:
 *   # Diff only (no writes)
 *   GITHUB_TOKEN=ghp_... tsx scripts/verify-ledger.ts
 *
 *   # Re-write ledger in-place (maintainers only)
 *   GITHUB_TOKEN=ghp_... tsx scripts/verify-ledger.ts --fix
 *
 * The script pages through all merged PRs in the repository, resolves each
 * one against the ledger rules (via the shared resolveLedgerRow helper), and
 * compares the computed set of rows to those currently in the file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLedgerRows,
  appendRowToMarkdown,
  listMergedPRs,
  resolveLedgerRow,
  type LedgerRow,
} from "./ledger-utils.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIX_MODE  = process.argv.includes("--fix");
const REPO      = process.env["REPO"] ?? "vortex-protocol/vortex-backend";
const token     = process.env["GITHUB_TOKEN"] ?? "";

if (!token) {
  console.error("Error: GITHUB_TOKEN environment variable is required.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a stable sort key for a ledger row (mergeDate ASC, then PR ASC).
 */
function rowSortKey(r: LedgerRow): string {
  return `${r.mergeDate}__${String(r.prNumber).padStart(8, "0")}`;
}

function rowId(r: LedgerRow): string {
  return `issue#${r.issueNumber}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ledgerPath = join(__dirname, "..", "docs", "DRIPS_WAVE_LEDGER.md");
  let markdown = readFileSync(ledgerPath, "utf8");
  const recordedRows = parseLedgerRows(markdown);

  console.log(`📖  Read ${recordedRows.length} existing ledger row(s) from DRIPS_WAVE_LEDGER.md`);

  // ── Fetch and recompute expected rows from the GitHub API ─────────────────
  console.log(`🔍  Fetching merged PRs from ${REPO}…`);
  let mergedPRs;
  try {
    mergedPRs = await listMergedPRs(REPO, token, 100);
  } catch (err) {
    console.error("Error fetching PRs:", err);
    process.exit(1);
  }

  console.log(`   Found ${mergedPRs.length} merged PR(s) to evaluate`);

  // Resolve each PR in isolation (pass empty existingRows — we want to
  // independently compute what *should* be in the ledger, ignoring duplicates
  // for now so we can detect missing rows).
  const expectedRows: LedgerRow[] = [];
  const skipped: Array<{ pr: number; reason: string }> = [];

  for (const pr of mergedPRs) {
    const result = await resolveLedgerRow(pr, [], token, REPO);
    if (result.appended) {
      expectedRows.push(result.row);
    } else if (result.reason !== "no_closes_ref") {
      // "no_closes_ref" is not a concern — many PRs don't close wave issues.
      skipped.push({ pr: pr.number, reason: `${result.reason}: ${result.detail}` });
    }
  }

  // ── Diff ─────────────────────────────────────────────────────────────────
  const recordedIds  = new Set(recordedRows.map(rowId));
  const expectedIds  = new Set(expectedRows.map(rowId));

  const missing   = expectedRows.filter((r) => !recordedIds.has(rowId(r)));
  const extra     = recordedRows.filter((r)  => !expectedIds.has(rowId(r)));

  // Check for point-value or contributor drifts among matching rows.
  const drifted: Array<{ recorded: LedgerRow; expected: LedgerRow }> = [];
  for (const exp of expectedRows) {
    const rec = recordedRows.find((r) => rowId(r) === rowId(exp));
    if (rec && (rec.points !== exp.points || rec.contributor !== exp.contributor)) {
      drifted.push({ recorded: rec, expected: exp });
    }
  }

  // Print results.
  if (skipped.length > 0) {
    console.log("\n⏭  Skipped PRs (not eligible for ledger):");
    for (const s of skipped) {
      console.log(`   PR #${s.pr}: ${s.reason}`);
    }
  }

  if (missing.length === 0 && extra.length === 0 && drifted.length === 0) {
    console.log("\n✅  Ledger is up to date — no drift detected.");
    return;
  }

  // Report drift.
  console.log("\n⚠️  Drift detected:");

  if (missing.length > 0) {
    console.log(`\n  Missing rows (${missing.length}):`);
    for (const r of missing.sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)))) {
      console.log(`    + ${r.mergeDate} | PR #${r.prNumber} | @${r.contributor} | issue #${r.issueNumber} | ${r.points} pts`);
    }
  }

  if (extra.length > 0) {
    console.log(`\n  Extra rows (${extra.length}) — in ledger file but not found via API:`);
    for (const r of extra) {
      console.log(`    - ${r.mergeDate} | PR #${r.prNumber} | @${r.contributor} | issue #${r.issueNumber}`);
    }
  }

  if (drifted.length > 0) {
    console.log(`\n  Drifted rows (${drifted.length}):`);
    for (const { recorded, expected } of drifted) {
      console.log(`    ~ issue #${recorded.issueNumber}:`);
      if (recorded.points !== expected.points) {
        console.log(`      points: recorded=${recorded.points} expected=${expected.points}`);
      }
      if (recorded.contributor !== expected.contributor) {
        console.log(`      contributor: recorded=@${recorded.contributor} expected=@${expected.contributor}`);
      }
    }
  }

  if (!FIX_MODE) {
    console.log(
      "\nRun with --fix to rewrite the ledger file, or open a PR to add missing rows.",
    );
    process.exit(1);
  }

  // ── Fix mode: append missing rows ─────────────────────────────────────────
  console.log("\n🔧  --fix mode: appending missing rows…");
  const toAppend = missing.sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));

  for (const row of toAppend) {
    markdown = appendRowToMarkdown(markdown, row);
    console.log(`   + Appended: issue #${row.issueNumber} (PR #${row.prNumber})`);
  }

  writeFileSync(ledgerPath, markdown, "utf8");
  console.log("\n✅  Ledger rewritten. Review the changes before committing.");

  if (extra.length > 0 || drifted.length > 0) {
    console.log(
      "\n⚠️  Extra/drifted rows require manual review — they were not automatically corrected.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
