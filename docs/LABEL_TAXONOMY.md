# Label Taxonomy and Issue Management

## Overview

This document defines the label taxonomy for GitHub Issues, used to categorize contributor work from `issues.md` and help new contributors discover work that matches their skill level.

## Label Categories

### Difficulty Labels

Used to indicate the expected difficulty and prerequisite knowledge for a given issue.

| Label | Color | Description | Candidates |
|-------|-------|-------------|-----------|
| `good-first-issue` | `#7057ff` | Suitable for newcomers with no major prerequisites; isolated, self-contained scope | Medium complexity issues with no unresolved High-complexity prerequisites |
| `help-wanted` | `#008672` | Open to anyone; may have a clear scope but could benefit from fresh eyes or bandwidth | Any complexity level without critical-path blocking |
| `hard` | `#d73a49` | Significant challenge; may require deep codebase knowledge or non-trivial design work | High complexity issues; new architectural patterns |

### Category Labels

Mirror the four implicit categories in `issues.md`:

| Label | Color | Description |
|-------|-------|-------------|
| `category/backend` | `#c2e0c6` | Backend API, services, database, integrations |
| `category/security` | `#fc2929` | Security audit, vulnerability disclosure, authentication |
| `category/devops` | `#1d76db` | Infrastructure, CI/CD, monitoring, operations |
| `category/governance` | `#ffc274` | Community, documentation, process, contributor onboarding |

### Status Labels

Track issue lifecycle:

| Label | Color | Description |
|-------|-------|-------------|
| `status/blocked` | `#d73a49` | Cannot proceed; describes blocker in the issue or comment |
| `status/in-progress` | `#0075ca` | Being actively worked on; PR referenced in issue or comment |
| `status/ready-to-merge` | `#a2eeef` | Approved PR awaiting merge; linked PR should reference issue number |

## Mapping Rules

### From `issues.md` to GitHub Issues

When mirroring an issue from `issues.md` to GitHub:

1. **Title**: Use the issue's `[DESCRIPTION]` line verbatim
2. **Body**: Include the full `[DESCRIPTION]` + `[PROBLEM STATEMENT & CONTEXT]` sections; link back to `issues.md`
3. **Category Label**: Determine from the issue's category in `issues.md`; apply one of `category/backend`, `category/security`, `category/devops`, or `category/governance`
4. **Difficulty Label**: Apply based on Complexity + prerequisites:
   - **`good-first-issue`**: If Complexity is `Medium` AND the issue description does not reference any High-complexity issue numbers as prerequisites
   - **`help-wanted`**: If the issue is open and not currently assigned, and is not blocked by another open issue
   - **`hard`**: If Complexity is `High`, always apply (in addition to category label)
5. **Prerequisites**: In the issue body, add a "Prerequisites" section listing any dependent issues (those referenced in Implementation Guidelines or Problem Statement)

**Example**: Issue #25 in `issues.md` is "Medium" complexity in Backend, doesn't reference a High blocker → `category/backend` + `good-first-issue`

### Exclusion Rules

Do **not** mark an issue as `good-first-issue` if:
- Any of its prerequisites are still open
- It requires significant cross-module refactoring
- Its description includes "TODO: [document the unfinished design]" or similar

## Maintenance

- When an issue is closed (PR merged), remove the `help-wanted` label if present
- When an issue moves to active work, add `status/in-progress` and reference the PR
- When a PR is approved, add `status/ready-to-merge` (removed on merge)
- Review labels quarterly as the backlog evolves

## Initial Seed Batch

The first batch of issues mirrored from `issues.md` (issues #316–#330) should include examples from all categories and both difficulty levels to establish a clear pattern for future contributors.

---

For more context on how the contributor backlog is managed, see [CONTRIBUTING.md](./CONTRIBUTING.md) and [issues.md](./issues.md) in the upstream repository.
