/**
 * Shared utilities for the Drips Wave Contributor Ledger pipeline.
 *
 * Used by both:
 *  - scripts/append-ledger-row.ts  (CI: append a row after a PR merge)
 *  - scripts/verify-ledger.ts      (audit: diff ledger vs GitHub API)
 *
 * @module scripts/ledger-utils
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row in the DRIPS_WAVE_LEDGER.md table. */
export interface LedgerRow {
  /** ISO date string: YYYY-MM-DD (UTC) */
  mergeDate: string;
  /** PR number, e.g. 501 */
  prNumber: number;
  /** GitHub login of the PR author (without @) */
  contributor: string;
  /** Linked issue number */
  issueNumber: number;
  /** Issue title at time of merge */
  issueTitle: string;
  /** Points awarded (150 or 200) */
  points: 150 | 200;
  /** Optional notes (co-author, fork, duplicate flag, etc.) */
  notes: string;
}

/** Outcome of resolving a PR against the ledger rules. */
export type AppendResult =
  | { appended: true; row: LedgerRow }
  | { appended: false; reason: SkipReason; detail: string };

export type SkipReason =
  | "no_closes_ref"       // PR body has no "Closes #N"
  | "missing_label"       // Issue has no recognised complexity label
  | "duplicate"           // Issue already has a ledger entry
  | "reverted"            // PR was reverted the same day
  | "api_error";          // Unrecoverable GitHub API error

// ---------------------------------------------------------------------------
// Label → Points mapping
// ---------------------------------------------------------------------------

/** Labels recognised as complexity signals (from docs/LABEL_TAXONOMY.md). */
export const COMPLEXITY_LABELS: Record<string, 150 | 200> = {
  hard:             200,
  medium:           150,
  "good-first-issue": 150,
};

/**
 * Resolves the point value from an array of GitHub label name strings.
 * Returns `null` if no recognised complexity label is found.
 */
export function resolvePoints(labels: string[]): 150 | 200 | null {
  for (const label of labels) {
    const pts = COMPLEXITY_LABELS[label.toLowerCase()];
    if (pts !== undefined) return pts;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extracts all issue numbers from a `Closes #N` pattern in a PR body.
 * Returns an empty array when none are found.
 *
 * Recognised forms (case-insensitive):
 *   Closes #123
 *   closes #123
 *   Fixes #123
 *   Resolves #123
 */
export function parseClosesRefs(body: string): number[] {
  const re = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;
  const issues: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    issues.push(parseInt(m[1], 10));
  }
  return [...new Set(issues)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Ledger file I/O
// ---------------------------------------------------------------------------

const LEDGER_START = "<!-- DRIPS_LEDGER_START -->";
const LEDGER_END   = "<!-- DRIPS_LEDGER_END -->";

/**
 * Parses existing ledger rows from the markdown file content.
 * Extracts rows from between the DRIPS_LEDGER_START/END HTML comment markers.
 */
export function parseLedgerRows(markdown: string): LedgerRow[] {
  const start = markdown.indexOf(LEDGER_START);
  const end   = markdown.indexOf(LEDGER_END);
  if (start === -1 || end === -1) return [];

  const section = markdown.slice(start + LEDGER_START.length, end);
  const rows: LedgerRow[] = [];

  // Match markdown table rows: | date | #pr | @contributor | #issue | title | pts | notes |
  const rowRe = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*#(\d+)\s*\|\s*@([\w-]+)(.*?)\|\s*#(\d+)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|$/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section)) !== null) {
    const pts = parseInt(m[7], 10);
    rows.push({
      mergeDate:   m[1],
      prNumber:    parseInt(m[2], 10),
      contributor: m[3],
      issueNumber: parseInt(m[5], 10),
      issueTitle:  m[6].trim(),
      points:      (pts === 200 ? 200 : 150) as 150 | 200,
      notes:       m[8].trim(),
    });
  }
  return rows;
}

/**
 * Formats a single ledger row as a markdown table row.
 */
export function formatRow(row: LedgerRow): string {
  const contributor = row.notes.includes("co-author")
    ? `@${row.contributor} ${row.notes.split(" ").find(p => p.startsWith("/@"))?.slice(1) ?? ""}`
    : `@${row.contributor}`;
  return `| ${row.mergeDate} | #${row.prNumber} | ${contributor} | #${row.issueNumber} | ${row.issueTitle} | ${row.points} | ${row.notes} |`;
}

/**
 * Appends a new row into the ledger section of the markdown file content.
 * Inserts before the DRIPS_LEDGER_END marker, preserving the section header.
 *
 * @returns Updated markdown string.
 */
export function appendRowToMarkdown(markdown: string, row: LedgerRow): string {
  const endIdx = markdown.indexOf(LEDGER_END);
  if (endIdx === -1) {
    throw new Error(`Ledger end marker '${LEDGER_END}' not found in DRIPS_WAVE_LEDGER.md`);
  }

  const newRowMd = formatRow(row);

  // Find the last table row before LEDGER_END to insert after it.
  const before = markdown.slice(0, endIdx);
  const after  = markdown.slice(endIdx);

  // Check if there is an existing table in the section; if not, add a header.
  const hasTable = /^\|.+\|$/m.test(before.slice(before.indexOf(LEDGER_START)));
  if (!hasTable) {
    // Insert a table header + separator + the new row
    const header = [
      "| Merge Date | PR | Contributor | Issue Number | Issue Title | Points | Notes |",
      "|------------|-----|-------------|--------------|-------------|--------|-------|",
      newRowMd,
      "",
    ].join("\n");
    return before.trimEnd() + "\n" + header + "\n" + after;
  }

  // Append the new row just before the closing marker.
  return before.trimEnd() + "\n" + newRowMd + "\n\n" + after;
}

// ---------------------------------------------------------------------------
// GitHub API minimal client (uses fetch, no Octokit dependency)
// ---------------------------------------------------------------------------

export interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  state: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  merged_at: string | null;
  head: { label: string };
}

const GH_API = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vortex-drips-ledger/1.0",
  };
}

/**
 * Fetches a single GitHub issue by number.
 */
export async function fetchIssue(
  repo: string,
  issueNumber: number,
  token: string,
): Promise<GitHubIssue> {
  const url = `${GH_API}/repos/${repo}/issues/${issueNumber}`;
  // eslint-disable-next-line no-restricted-syntax -- standalone script, no HttpEgressService in scope
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub API error fetching issue #${issueNumber}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<GitHubIssue>;
}

/**
 * Fetches merged PRs that close a specific issue by listing events on the issue.
 * Returns the PR numbers that closed the issue.
 */
export async function fetchClosingPRs(
  repo: string,
  issueNumber: number,
  token: string,
): Promise<number[]> {
  // GitHub doesn't have a direct "closing PRs" endpoint in REST v3 — we use
  // the timeline events to find cross-reference events with "closed" source.
  const url = `${GH_API}/repos/${repo}/issues/${issueNumber}/timeline?per_page=100`;
  // eslint-disable-next-line no-restricted-syntax -- standalone script, no HttpEgressService in scope
  const res = await fetch(url, {
    headers: {
      ...ghHeaders(token),
      Accept: "application/vnd.github.mockingbird-preview+json",
    },
  });
  if (!res.ok) return [];

  const events = (await res.json()) as Array<{
    event: string;
    source?: { type: string; issue?: { pull_request?: { merged_at?: string | null }; number: number } };
  }>;

  return events
    .filter(
      (e) =>
        e.event === "cross-referenced" &&
        e.source?.type === "issue" &&
        e.source.issue?.pull_request?.merged_at != null,
    )
    .map((e) => e.source!.issue!.number);
}

/**
 * Lists recently merged PRs in a repository (up to `perPage`).
 */
export async function listMergedPRs(
  repo: string,
  token: string,
  perPage = 100,
): Promise<GitHubPR[]> {
  const url = `${GH_API}/repos/${repo}/pulls?state=closed&per_page=${perPage}&sort=updated&direction=desc`;
  // eslint-disable-next-line no-restricted-syntax -- standalone script, no HttpEgressService in scope
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub API error listing PRs: ${res.status} ${res.statusText}`);
  }
  const prs = (await res.json()) as GitHubPR[];
  return prs.filter((pr) => pr.merged_at !== null);
}

// ---------------------------------------------------------------------------
// Core eligibility logic
// ---------------------------------------------------------------------------

/**
 * Determines whether a PR is eligible for a ledger row and builds the row if so.
 *
 * @param pr           PR payload from the GitHub event or API.
 * @param existingRows Already-recorded ledger rows (for duplicate detection).
 * @param token        GitHub API token.
 * @param repo         "owner/repo" string.
 */
export async function resolveLedgerRow(
  pr: GitHubPR,
  existingRows: LedgerRow[],
  token: string,
  repo: string,
): Promise<AppendResult> {
  // 1. Parse "Closes #N" references from the PR body.
  const body = pr.body ?? "";
  const closes = parseClosesRefs(body);

  if (closes.length === 0) {
    return { appended: false, reason: "no_closes_ref", detail: "PR body contains no 'Closes #N' reference" };
  }

  // Use the first issue reference (per accounting rules).
  const primaryIssue = closes[0];
  const extraIssues  = closes.slice(1);

  // 2. Duplicate guard — check if this issue already has a ledger row.
  const isDuplicate = existingRows.some((r) => r.issueNumber === primaryIssue);
  if (isDuplicate) {
    return {
      appended: false,
      reason: "duplicate",
      detail: `Issue #${primaryIssue} already has a ledger entry`,
    };
  }

  // 3. Fetch the linked issue to read its labels.
  let issue: GitHubIssue;
  try {
    issue = await fetchIssue(repo, primaryIssue, token);
  } catch (err) {
    return {
      appended: false,
      reason: "api_error",
      detail: String(err),
    };
  }

  // 4. Resolve complexity → points.
  const labelNames = issue.labels.map((l) => l.name);
  const points = resolvePoints(labelNames);
  if (points === null) {
    return {
      appended: false,
      reason: "missing_label",
      detail: `Issue #${primaryIssue} has no recognised complexity label (found: ${labelNames.join(", ") || "none"})`,
    };
  }

  // 5. Build the row.
  const mergeDate = (pr.merged_at ?? new Date().toISOString()).slice(0, 10);

  const notes: string[] = [];
  if (extraIssues.length > 0) {
    notes.push(`also closes ${extraIssues.map((n) => `#${n}`).join(", ")}`);
  }

  const row: LedgerRow = {
    mergeDate,
    prNumber:    pr.number,
    contributor: pr.user.login,
    issueNumber: primaryIssue,
    issueTitle:  issue.title,
    points,
    notes:       notes.join("; "),
  };

  return { appended: true, row };
}
