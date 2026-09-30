# ADR 0006: Protocol fee engine and ledger

- **Status**: Accepted
- **Date**: 2026-09-29
- **Technical Story**: #438 — configurable fees, tiers, referral share, double-entry ledger

## Context

`feeAmount` was a flat 5 bps truncated division at fill time, and again inside quoting. There was no rule version, no integrator share, and no ledger that could be reconciled.

## Decision

`src/fees/` quotes a fee from versioned rules. Precedence is specific pair, then source chain, then the built-in default (5 bps, the previous rate). A rule may set basis points, a min and max in base units, and volume tiers selected by trade size (or a caller-supplied cumulative volume).

The charged fee is `ceil(amount * bps / 10_000)`, then clamped. Ceil is at most one base unit above truncating division. Caps may move the fee further; that difference is the cap. Integrator share is a floor of the fee, so the remainder stays with the treasury. An unknown referral code quotes no integrator share.

A fill posts the quote of the fill amount: debit the user, credit the treasury, and credit the integrator when the share is non-zero. The ledger refuses a batch unless the sum of debits equals the sum of credits. The same function produces the quote and the realized fee, so they match when the amount, chains, tokens, and referral match.

`GET` treasury stats keep the intent `feeAmount` totals until the ledger has postings, then report the ledger totals. On-chain fee collection is unchanged. Rules and referrals are `FEE_RULES_JSON` and `FEE_REFERRALS_JSON`.

The durable table is `fee_ledger`. The running service posts to an in-memory ledger with the same shape (the same pattern as the other default `memory` adapters).

## Consequences

- Quote responses gain `treasuryFee`, `integratorFee`, `feeRuleVersion`, and `referralCode`.
- Fills of amounts that do not divide evenly by the bps denominator cost one extra base unit versus the old truncated fee.
