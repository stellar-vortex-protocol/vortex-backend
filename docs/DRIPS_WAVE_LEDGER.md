# Drips Wave Contributor Ledger

This document records contributions to the vortex-backend contributor incentive program (Drips Wave),
tracking issue numbers, contributors, merge dates, and points awarded.

> **Automated:** ledger rows are appended automatically by the
> `.github/workflows/drips-ledger.yml` GitHub Action on every merged PR that
> closes a tracked wave issue. Manual edits to the Ledger section are strongly
> discouraged — use the verification script to audit instead.

---

## Format

| Merge Date | PR | Contributor | Issue Number | Issue Title | Points | Notes |
|------------|-----|-------------|--------------|-------------|--------|-------|
| YYYY-MM-DD | #XXX | @username | #N | Short description | 150/200 | Any special context |

### Column definitions

| Column | Source | Notes |
|--------|--------|-------|
| Merge Date | `pull_request.merged_at` (UTC, `YYYY-MM-DD`) | Date the PR was merged into `main` |
| PR | Pull-request number | Prefixed `#` |
| Contributor | PR author's GitHub login | Prefixed `@`; co-authors listed with ` / @co-author` |
| Issue Number | Parsed from `Closes #N` in PR body | First resolved issue wins |
| Issue Title | Issue title at time of merge | Fetched from GitHub API |
| Points | Derived from complexity label | `hard` → 200 pts, `medium` or `good-first-issue` → 150 pts |
| Notes | Optional | Auto-populated for co-author, fork, or duplicate flags |

---

## Ledger

<!-- DRIPS_LEDGER_START -->
### Phase 1 (Q3 2026)

| Merge Date | PR | Contributor | Issue Number | Issue Title | Points | Notes |
|------------|-----|-------------|--------------|-------------|--------|-------|
| _(initial seed — populated on first wave merge)_ | | | | | | |

<!-- DRIPS_LEDGER_END -->

---

## Accounting Rules

### Point Values

Points are determined by the **complexity label** attached to the linked issue:

| GitHub Label | Complexity | Points |
|---|---|---|
| `hard` | High | **200** |
| `medium` | Medium | **150** |
| `good-first-issue` | Low/Medium | **150** |

See [`docs/LABEL_TAXONOMY.md`](./LABEL_TAXONOMY.md) for full label definitions.

### Eligibility

A PR is eligible for a ledger entry when **all** of the following are true:

1. The PR is merged (not just closed) into `main`.
2. The PR description contains `Closes #N` referencing a wave issue.
3. The linked issue carries exactly one complexity label (`hard`, `medium`,
   or `good-first-issue`).
4. No prior ledger row exists for the same issue number (duplicate guard).
5. The PR was not subsequently reverted within the same day (revert guard
   checks for a `revert-` prefixed PR targeting the same branch).

### Co-authors

If a PR has multiple contributors listed as git co-authors
(`Co-authored-by: Name <email>` in the commit message), the first co-author
GitHub login is appended with ` / @co-author` in the Contributor cell. Points
are awarded as a single entry to the PR author; split-credit decisions are
handled off-ledger.

### Multiple Issues

If a PR closes multiple issues (`Closes #A`, `Closes #B`), only the
**first** issue in document order is resolved for ledger purposes. The
others are noted in the Notes column.

### Fork PRs

PRs from forked repositories are handled identically to in-repo PRs. The
workflow uses the read-only `GITHUB_TOKEN` permission and does not require
any write access from the fork.

---

## Automated Pipeline

The pipeline is implemented in `.github/workflows/drips-ledger.yml` and runs
on every `pull_request` event where `action == 'closed'` **and** `merged == true`.

### Workflow Steps

```
PR merged
  │
  ▼
1. Parse PR body for "Closes #N"
2. Fetch issue labels via GitHub API
3. Resolve complexity → points
4. Validate eligibility (duplicate, missing label)
5. Build ledger row (ISO date, PR#, @author, #issue, title, pts)
6. Open / update single batched "ledger update" PR
   (branch: automated/drips-ledger-update)
```

### Batched PR Strategy

Rather than one PR per merge, the workflow reuses a single open PR on branch
`automated/drips-ledger-update`. If that branch/PR already exists, the new
row is appended and the PR description is updated. This keeps the ledger
update noise low and reviewers can batch-approve a daily run.

### Least-Privilege Token

The workflow uses a dedicated `LEDGER_BOT_TOKEN` secret (a
`contents: write, pull-requests: write` fine-grained PAT scoped to this
repo). If the secret is absent the workflow skips silently so forks don't
fail on missing secrets.

---

## Verification / Audit

The `scripts/verify-ledger.ts` script independently recomputes the ledger
from the GitHub API and diffs against the checked-in file. Run it locally:

```bash
# Dry-run diff (no writes)
GITHUB_TOKEN=ghp_... tsx scripts/verify-ledger.ts

# Rewrite ledger in-place (for maintainers)
GITHUB_TOKEN=ghp_... tsx scripts/verify-ledger.ts --fix
```

Exit code `0` = ledger matches; `1` = drift detected (diff printed to stdout).

---

## Source of Truth

Each PR must reference an issue number in its description:

```
Closes #<issue-number>
```

This creates a verifiable link between the merged PR and the issue entry,
enabling the automated ledger update.

The ledger is **append-only**; rows are not deleted or modified once recorded.
Any necessary correction is a new row with `Notes` referencing the erroneous
row.

---

## Dispute Resolution

Disputes about point allocation or contributor attribution follow the
escalation ladder in
[CODE_OF_CONDUCT.md](https://github.com/vortex-protocol/.github/blob/main/CODE_OF_CONDUCT.md):

1. **Clarification**: Poster of ledger entry and contributor agree on facts
2. **Maintainer review**: If disagreement persists, a maintainer with push
   access reviews the issue and PR
3. **Escalation**: Unresolved disputes are brought to the team lead for final
   decision

Changes to the ledger (if any are needed) are documented in a follow-up
commit with reasoning.

---

## Notes

- This ledger is not a replacement for contributor recognition elsewhere
  (e.g. GitHub's contributor graph, release notes)
- Point totals do not automatically convert to payments or rewards; that is
  handled separately and outside this repository
- Ledger entries are public and auditable; disputes and resolutions are also
  documented publicly

---

For more context on the Drips Wave program, see:

- [`docs/LABEL_TAXONOMY.md`](./LABEL_TAXONOMY.md) — label definitions and
  mapping rules
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor workflow
- [`CHANGELOG.md`](../CHANGELOG.md) — user-facing changes
