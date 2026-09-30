/**
 * Unit tests for scripts/ledger-utils.ts
 *
 * All GitHub API calls are replaced by recorded fixtures so the suite is
 * fully offline and deterministic.
 */

import {
  parseClosesRefs,
  resolvePoints,
  parseLedgerRows,
  appendRowToMarkdown,
  resolveLedgerRow,
  type GitHubPR,
  type LedgerRow,
} from "../../scripts/ledger-utils";

// ---------------------------------------------------------------------------
// Fixtures — recorded GitHub API responses
// ---------------------------------------------------------------------------

/** A basic merged PR that closes issue #501 (hard/High complexity) */
const PR_501: GitHubPR = {
  number: 501,
  title: "feat(drips): automated ledger pipeline",
  body: "Closes #501\n\nImplements the pipeline.",
  user: { login: "octocat" },
  merged_at: "2026-09-28T06:45:00Z",
  head: { label: "octocat:feat/drips-ledger-pipeline-501" },
};

/** A PR with no Closes reference */
const PR_NO_CLOSES: GitHubPR = {
  number: 99,
  title: "chore: bump deps",
  body: "Just bumping dependencies.",
  user: { login: "dependabot" },
  merged_at: "2026-09-28T07:00:00Z",
  head: { label: "dependabot:bump" },
};

/** A PR closing multiple issues */
const PR_MULTI_CLOSES: GitHubPR = {
  number: 200,
  title: "fix: resolve two bugs",
  body: "Closes #300\nCloses #301\nSome description.",
  user: { login: "devuser" },
  merged_at: "2026-09-27T12:00:00Z",
  head: { label: "devuser:fix/two-bugs" },
};

/** A PR with a null body */
const PR_NULL_BODY: GitHubPR = {
  number: 55,
  title: "chore: null body",
  body: null,
  user: { login: "ghostuser" },
  merged_at: "2026-09-26T00:00:00Z",
  head: { label: "ghostuser:chore" },
};

/** Fixture issue with "hard" label (200 pts) */
const ISSUE_HARD = {
  number: 501,
  title: "Automated Drips Wave Contributor Ledger Pipeline",
  labels: [{ name: "hard" }, { name: "category/devops" }],
  state: "open",
};

/** Fixture issue with "medium" label (150 pts) */
const ISSUE_MEDIUM = {
  number: 300,
  title: "Fix pagination in /users endpoint",
  labels: [{ name: "medium" }, { name: "category/backend" }],
  state: "open",
};

/** Fixture issue with "good-first-issue" label (150 pts) */
const ISSUE_GOOD_FIRST = {
  number: 42,
  title: "Add missing TSDoc to routing service",
  labels: [{ name: "good-first-issue" }],
  state: "open",
};

/** Fixture issue with no complexity label */
const ISSUE_NO_LABEL = {
  number: 77,
  title: "Some unlabelled issue",
  labels: [{ name: "category/backend" }],
  state: "open",
};

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

function makeFetch(issueMap: Record<number, typeof ISSUE_HARD>): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = String(input);
    const m = /\/issues\/(\d+)$/.exec(url);
    if (m) {
      const num = parseInt(m[1], 10);
      const issue = issueMap[num];
      if (!issue) {
        return { ok: false, status: 404, statusText: "Not Found" } as Response;
      }
      return { ok: true, json: async () => issue } as Response;
    }
    // Default: 404 for unmatched URLs
    return { ok: false, status: 404, statusText: "Not Found" } as Response;
  };
}

// ---------------------------------------------------------------------------
// parseClosesRefs
// ---------------------------------------------------------------------------

describe("parseClosesRefs", () => {
  it("extracts a single issue number", () => {
    expect(parseClosesRefs("Closes #123")).toEqual([123]);
  });

  it("is case-insensitive", () => {
    expect(parseClosesRefs("closes #42\nFIXES #99")).toEqual([42, 99]);
  });

  it("handles Fixes and Resolves keywords", () => {
    expect(parseClosesRefs("Fixes #7\nResolves #8")).toEqual([7, 8]);
  });

  it("deduplicates repeated refs", () => {
    expect(parseClosesRefs("Closes #5\nCloses #5")).toEqual([5]);
  });

  it("returns empty array when no closes ref present", () => {
    expect(parseClosesRefs("Just a description with no refs")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseClosesRefs("")).toEqual([]);
  });

  it("handles multiple distinct issues", () => {
    expect(parseClosesRefs("Closes #300\nCloses #301")).toEqual([300, 301]);
  });
});

// ---------------------------------------------------------------------------
// resolvePoints
// ---------------------------------------------------------------------------

describe("resolvePoints", () => {
  it("returns 200 for 'hard' label", () => {
    expect(resolvePoints(["hard", "category/devops"])).toBe(200);
  });

  it("returns 150 for 'medium' label", () => {
    expect(resolvePoints(["category/backend", "medium"])).toBe(150);
  });

  it("returns 150 for 'good-first-issue' label", () => {
    expect(resolvePoints(["good-first-issue"])).toBe(150);
  });

  it("returns null when no recognised label is present", () => {
    expect(resolvePoints(["category/backend", "help-wanted"])).toBeNull();
  });

  it("returns null for empty label array", () => {
    expect(resolvePoints([])).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(resolvePoints(["Hard"])).toBe(200);
    expect(resolvePoints(["MEDIUM"])).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// parseLedgerRows
// ---------------------------------------------------------------------------

describe("parseLedgerRows", () => {
  const SAMPLE_LEDGER = `
# Drips Wave Contributor Ledger

<!-- DRIPS_LEDGER_START -->
### Phase 1

| Merge Date | PR | Contributor | Issue Number | Issue Title | Points | Notes |
|------------|-----|-------------|--------------|-------------|--------|-------|
| 2026-09-01 | #10 | @alice | #100 | First task | 200 |  |
| 2026-09-02 | #11 | @bob | #101 | Second task | 150 | co-author |
<!-- DRIPS_LEDGER_END -->
`;

  it("parses rows from the ledger section", () => {
    const rows = parseLedgerRows(SAMPLE_LEDGER);
    expect(rows).toHaveLength(2);
  });

  it("correctly maps the first row fields", () => {
    const rows = parseLedgerRows(SAMPLE_LEDGER);
    expect(rows[0]).toMatchObject({
      mergeDate:   "2026-09-01",
      prNumber:    10,
      contributor: "alice",
      issueNumber: 100,
      points:      200,
    });
  });

  it("correctly maps the second row notes", () => {
    const rows = parseLedgerRows(SAMPLE_LEDGER);
    expect(rows[1].notes).toBe("co-author");
  });

  it("returns empty array when markers are absent", () => {
    expect(parseLedgerRows("# No markers here")).toEqual([]);
  });

  it("returns empty array for empty ledger section", () => {
    const md = "<!-- DRIPS_LEDGER_START -->\n<!-- DRIPS_LEDGER_END -->";
    expect(parseLedgerRows(md)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appendRowToMarkdown
// ---------------------------------------------------------------------------

describe("appendRowToMarkdown", () => {
  const BASE_MD = `# Drips Wave

<!-- DRIPS_LEDGER_START -->
### Phase 1

| Merge Date | PR | Contributor | Issue Number | Issue Title | Points | Notes |
|------------|-----|-------------|--------------|-------------|--------|-------|
| 2026-09-01 | #10 | @alice | #100 | Existing task | 200 |  |

<!-- DRIPS_LEDGER_END -->
`;

  const NEW_ROW: LedgerRow = {
    mergeDate:   "2026-09-28",
    prNumber:    501,
    contributor: "octocat",
    issueNumber: 501,
    issueTitle:  "Ledger Pipeline",
    points:      200,
    notes:       "",
  };

  it("appends a new row before the end marker", () => {
    const updated = appendRowToMarkdown(BASE_MD, NEW_ROW);
    expect(updated).toContain("| 2026-09-28 | #501 | @octocat | #501 | Ledger Pipeline | 200 |");
    expect(updated.indexOf("<!-- DRIPS_LEDGER_END -->")).toBeGreaterThan(
      updated.indexOf("#501"),
    );
  });

  it("preserves the existing row", () => {
    const updated = appendRowToMarkdown(BASE_MD, NEW_ROW);
    expect(updated).toContain("| 2026-09-01 | #10 | @alice | #100 | Existing task | 200 |");
  });

  it("throws when the end marker is missing", () => {
    expect(() =>
      appendRowToMarkdown("# No markers", NEW_ROW),
    ).toThrow(/DRIPS_LEDGER_END/);
  });

  it("adds a table header when section has no table yet", () => {
    const emptySection = `# Drips\n<!-- DRIPS_LEDGER_START -->\n### Phase 1\n\n<!-- DRIPS_LEDGER_END -->\n`;
    const updated = appendRowToMarkdown(emptySection, NEW_ROW);
    expect(updated).toContain("| Merge Date | PR |");
    expect(updated).toContain("| 2026-09-28 | #501 |");
  });
});

// ---------------------------------------------------------------------------
// resolveLedgerRow
// ---------------------------------------------------------------------------

describe("resolveLedgerRow", () => {
  const TOKEN = "ghp_test_token";
  const REPO  = "vortex-protocol/vortex-backend";

  beforeEach(() => {
    // Reset global fetch mock before each test.
    global.fetch = makeFetch({ 501: ISSUE_HARD, 300: ISSUE_MEDIUM, 42: ISSUE_GOOD_FIRST, 77: ISSUE_NO_LABEL });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns appended=true with correct row for a hard-complexity PR", async () => {
    const result = await resolveLedgerRow(PR_501, [], TOKEN, REPO);
    expect(result.appended).toBe(true);
    if (!result.appended) return;

    expect(result.row).toMatchObject({
      prNumber:    501,
      contributor: "octocat",
      issueNumber: 501,
      points:      200,
      mergeDate:   "2026-09-28",
    });
  });

  it("returns appended=false with reason=no_closes_ref when PR body has no Closes ref", async () => {
    const result = await resolveLedgerRow(PR_NO_CLOSES, [], TOKEN, REPO);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.reason).toBe("no_closes_ref");
  });

  it("returns appended=false with reason=no_closes_ref for null PR body", async () => {
    const result = await resolveLedgerRow(PR_NULL_BODY, [], TOKEN, REPO);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.reason).toBe("no_closes_ref");
  });

  it("returns appended=false with reason=duplicate when issue already has a ledger row", async () => {
    const existing: LedgerRow[] = [
      {
        mergeDate: "2026-09-01", prNumber: 500, contributor: "alice",
        issueNumber: 501, issueTitle: "Old entry", points: 200, notes: "",
      },
    ];
    const result = await resolveLedgerRow(PR_501, existing, TOKEN, REPO);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.reason).toBe("duplicate");
  });

  it("returns appended=false with reason=missing_label when issue has no complexity label", async () => {
    const prNoLabel: GitHubPR = { ...PR_501, body: "Closes #77" };
    const result = await resolveLedgerRow(prNoLabel, [], TOKEN, REPO);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.reason).toBe("missing_label");
  });

  it("returns appended=false with reason=api_error when issue fetch fails", async () => {
    global.fetch = makeFetch({}); // empty map → 404 for all issues
    const result = await resolveLedgerRow(PR_501, [], TOKEN, REPO);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.reason).toBe("api_error");
  });

  it("uses the first issue when PR closes multiple", async () => {
    // PR_MULTI_CLOSES closes #300 then #301 — only #300 is in issueMap
    const result = await resolveLedgerRow(PR_MULTI_CLOSES, [], TOKEN, REPO);
    expect(result.appended).toBe(true);
    if (!result.appended) return;
    expect(result.row.issueNumber).toBe(300);
    expect(result.row.points).toBe(150); // medium
    expect(result.row.notes).toContain("#301");
  });

  it("awards 150 pts for good-first-issue label", async () => {
    const prGoodFirst: GitHubPR = { ...PR_501, number: 42, body: "Closes #42", user: { login: "newbie" } };
    const result = await resolveLedgerRow(prGoodFirst, [], TOKEN, REPO);
    expect(result.appended).toBe(true);
    if (!result.appended) return;
    expect(result.row.points).toBe(150);
    expect(result.row.contributor).toBe("newbie");
  });

  it("records the merge date as YYYY-MM-DD", async () => {
    const result = await resolveLedgerRow(PR_501, [], TOKEN, REPO);
    expect(result.appended).toBe(true);
    if (!result.appended) return;
    expect(result.row.mergeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
