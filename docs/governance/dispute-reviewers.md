# Dispute reviewer selection

This document describes who may adjudicate solver slash disputes and how they
are held accountable. It is the governance counterpart to the `src/disputes/`
module.

## Role

A **dispute reviewer** moves a dispute from `open` to `under_review` and then
decides it as `upheld` (the slash stands) or `overturned` (the slash is rolled
back, reputation restored, and a treasury refund requested). Reviewers never act
on-chain — arbitration remains out of scope; overturned disputes produce a
`TreasuryRefundRequest` record that a separate, change-managed process executes.

## Selection

- Reviewers are a small, rotating set of neutral operators appointed by the
  protocol maintainers (not solvers, to avoid conflicts of interest).
- A reviewer is identified by a Stellar public key listed in the
  `REVIEWER_ADDRESSES` environment variable (comma-separated). Only these keys
  may perform review/decide actions, and every action must be signed with the
  corresponding key (verified by `ReviewerGuard`).
- Rotate membership deliberately: adding/removing a key is a config change with
  a written changelog entry, so review authority is auditable.

## Duties and SLA

- Reviewers aim to decide within `DISPUTE_SLA_SECONDS` (7 days) of submission.
  Missed deadlines surface in the public dispute statistics (`withinSla`).
- A decision is recorded with the reviewer's identity and a written `reason`
  (required). Once decided, a dispute is immutable.

## Recusal and conflicts

- A reviewer must recuse from any dispute involving a solver they operate,
  are affiliated with, or have a financial stake in.
- If a quorum of reviewers is unavailable or conflicted, the dispute remains
  `under_review` and is escalated to the maintainers rather than decided by a
  conflicted party.

## Auditability

- The public, anonymised statistics endpoint (`GET /api/v1/solvers/disputes/stats`)
  reports aggregate counts and overturn rate without exposing solver identities,
  so reviewer behaviour is externally observable without deanonymising solvers.
