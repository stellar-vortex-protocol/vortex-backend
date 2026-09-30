# Semgrep — protocol-specific hazards (issue #478)

Custom rules live in `rules/` and run in CI (`semgrep scan --error`) plus
`semgrep --test` over `tests/` fixtures.

## Rules

| Rule | Severity | What it catches |
|---|---|---|
| `no-number-money` | ERROR | `Number()/parseFloat/parseInt` on `*Amount*/fee/price/balance/volume` — amounts are bigint-as-string |
| `no-float-fee-math` | ERROR | `Number(fee)` / float division fee math |
| `no-config-logging` | WARNING | logging config objects (secret leak) |
| `unguarded-admin-route` | ERROR | `@Controller(*admin*)` without guard |
| `no-direct-state-mutation` | ERROR | `update({state: ...})` bypassing the state machine |
| `no-query-raw-unsafe` | ERROR | `$queryRawUnsafe` |
| `require-signature-verify` | WARNING | mutating intent routes without `verifyStellarSignature` |
| `no-txhash-log` | WARNING | raw tx-hash string interpolation in logs |

## Suppression policy

- Prefer fixing over suppressing. Suppressions require `// nosemgrep: <rule> -- <justification>`
  with a linked issue, and must be low-volume enough to keep PR friction low.
- Existing `Number(BigInt-diff)` sort comparators and `Number(fee)/pow` display
  conversions are intentionally flagged for follow-up migration to bigint-safe
  helpers — suppress individually with justification, do not disable rules.

## Local runs

```bash
npx @semgrep/cli scan --config .semgrep/rules --error
npx @semgrep/cli --test --config .semgrep/rules .semgrep/tests
```
