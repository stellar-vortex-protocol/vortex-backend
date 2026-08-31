# Drips Wave Contributor Ledger

This document records contributions to the vortex-backend contributor incentive program (Drips Wave), tracking issue numbers, contributors, merge dates, and points awarded.

## Format

| Merge Date | PR | Contributor | Issue Number | Issue Title | Points | Notes |
|------------|-----|-------------|--------------|-------------|--------|-------|
| YYYY-MM-DD | #XXX | @username | #N | Short description | 150/200 | Any special context |

## Ledger

### Phase 1 (Q3 2026)

_(Initial seed batch — to be populated as first wave of issues are completed)_

## Accounting Rules

### Point Values

- **High complexity**: 200 points
- **Medium complexity**: 150 points

Complexity levels are defined in `issues.md` (upstream) and referenced in GitHub Issue descriptions.

### Source of Truth

Each PR must reference an issue number in its description:
```
Closes #<issue-number>
```

This creates a verifiable link between the merged PR and the `issues.md` entry, enabling automated or manual ledger updates.

### Recording Process

1. **PR opens**: Author ensures the description includes `Closes #<issue-number>`
2. **PR merged**: Merge commit title captures the change; the linked issue is the join key
3. **Ledger update**: A maintainer (or automated CI job, if implemented) adds a row to this ledger

The ledger is append-only; rows are not deleted or modified once recorded.

### Dispute Resolution

Disputes about point allocation or contributor attribution follow the escalation ladder in
[CODE_OF_CONDUCT.md](https://github.com/vortex-protocol/.github/blob/main/CODE_OF_CONDUCT.md):

1. **Clarification**: Poster of ledger entry and contributor agree on facts
2. **Maintainer review**: If disagreement persists, a maintainer with push access reviews the issue and PR
3. **Escalation**: Unresolved disputes are brought to the team lead for final decision

Changes to the ledger (if any are needed) are documented in a follow-up commit with reasoning.

## Notes

- This ledger is not a replacement for contributor recognition elsewhere (e.g. GitHub's contributor graph, release notes)
- Point totals do not automatically convert to payments or rewards; that is handled separately and outside this repository
- Ledger entries are public and auditable; disputes and resolutions are also documented publicly

---

For more context on the Drips Wave program, see:
- `issues.md` (upstream, in vortex-protocol/.github) — defines issues and point values
- [CONTRIBUTING.md](./CONTRIBUTING.md) — contributor workflow
- `CHANGELOG.md` — user-facing changes
