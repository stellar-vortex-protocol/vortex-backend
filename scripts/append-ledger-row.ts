/**
 * append-ledger-row.ts
 *
 * Called by .github/workflows/drips-ledger.yml on every merged PR.
 * Reads environment variables injected by the workflow, resolves the
 * contribution, and appends a row to docs/DRIPS_WAVE_LEDGER.md.
 *
 * Sets GitHub Actions output variables:
 *   row_appended  — "true" | "false"
 *   skip_reason   — populated when row_appended is "false"
 *   pr_body       — markdown summary for the batched ledger PR description
 *
 * Run:
 *   GITHUB_TOKEN=ghp_... PR_NUMBER=501 PR_BODY="Closes #123" \
 *   PR_AUTHOR=octocat PR_MERGED_AT=2026-09-28T06:00:00Z \
 *   REPO=vortex-protocol/vortex-backend \
 *   tsx scripts/append-ledger-row.ts
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLedgerRows,
  appendRowToMarkdown,
  resolveLedgerRow,
  type GitHubPR,
} from "./ledger-utils.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const token      = requireEnv("GITHUB_TOKEN");
const repo       = requireEnv("REPO");              // "owner/repo"
const prNumber   = parseInt(requireEnv("PR_NUMBER"), 10);
const prBody     = process.env["PR_BODY"] ?? "";
const prAuthor   = requireEnv("PR_AUTHOR");
const prMergedAt = process.env["PR_MERGED_AT"] ?? new Date().toISOString();

// ---------------------------------------------------------------------------
// GitHub Actions output helpers
// ---------------------------------------------------------------------------

/** Appends a key=value pair to $GITHUB_OUTPUT (Actions multi-line safe). */
function setOutput(name: string, value: string): void {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile) {
    // Use delimiter syntax to handle multi-line values safely.
    appendFileSync(outputFile, `${name}<<EOF\n${value}\nEOF\n`);
  } else {
    // Local dev: just log it.
    console.log(`[output] ${name}=${value}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ledgerPath = join(__dirname, "..", "docs", "DRIPS_WAVE_LEDGER.md");
  const markdown = readFileSync(ledgerPath, "utf8");
  const existingRows = parseLedgerRows(markdown);

  // Build a minimal PR object from env vars (the full payload is available
  // via event JSON, but env vars keep this script testable in isolation).
  const pr: GitHubPR = {
    number:    prNumber,
    title:     "",
    body:      prBody,
    user:      { login: prAuthor },
    merged_at: prMergedAt,
    head:      { label: "" },
  };

  const result = await resolveLedgerRow(pr, existingRows, token, repo);

  if (!result.appended) {
    console.log(`⏭  Skipping: ${result.reason} — ${result.detail}`);
    setOutput("row_appended", "false");
    setOutput("skip_reason", `${result.reason}: ${result.detail}`);
    return;
  }

  const { row } = result;

  // Append the row to the markdown file.
  const updated = appendRowToMarkdown(markdown, row);
  writeFileSync(ledgerPath, updated, "utf8");

  console.log(
    `✅  Appended ledger row for PR #${row.prNumber} → issue #${row.issueNumber} (${row.points} pts)`,
  );

  // Set outputs for the subsequent workflow steps.
  setOutput("row_appended", "true");
  setOutput(
    "pr_body",
    [
      `### Row added — PR #${row.prNumber}`,
      "",
      `- **Contributor**: @${row.contributor}`,
      `- **Issue**: #${row.issueNumber} — ${row.issueTitle}`,
      `- **Points**: ${row.points}`,
      `- **Merge date**: ${row.mergeDate}`,
      row.notes ? `- **Notes**: ${row.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
