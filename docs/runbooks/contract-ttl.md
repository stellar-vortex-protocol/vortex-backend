# Runbook: Contract-State TTL Keeper

Issue #395. Soroban archives persistent ledger entries whose TTL runs out.
An archived contract instance or WASM code entry breaks every call to that
contract until someone pays to restore it, and an archived intent or bond
entry adds a restore to the critical path of the next write. The TTL keeper
extends these entries before that happens.

## What it does

`TtlKeeperService` (`src/soroban/ttl-keeper.service.ts`) runs on the elected
leader (`ttl-keeper` worker) every `TTL_KEEPER_INTERVAL_MS`:

1. **Derive keys** (`src/soroban/ttl-keys.ts`):
   - contract instance of `SETTLEMENT_CONTRACT_ID` and `SOLVER_REGISTRY_CONTRACT_ID`;
   - WASM code entry of each (hash read from the instance);
   - `DataKey::<TTL_KEEPER_INTENT_KEY_VARIANT>(intent_id)` in the settlement
     contract for every intent in `open`, `accepted` or a `pending_*` state;
   - `DataKey::<TTL_KEEPER_BOND_KEY_VARIANT>(solver)` in the solver registry
     for every active solver.
2. **Read** `liveUntilLedgerSeq` for every key with `getLedgerEntries`.
3. **Extend** every live key with `remaining ≤ TTL_KEEPER_THRESHOLD_LEDGERS`
   to `TTL_KEEPER_EXTEND_TO_LEDGERS`, using `ExtendFootprintTTL`
   transactions of at most `TTL_KEEPER_MAX_KEYS_PER_TX` keys. Instance and
   code go first, then the entries closest to archival.
4. **Stop** when the next transaction would exceed
   `TTL_KEEPER_DAILY_BUDGET_STROOPS` for the current UTC day.

Missing entries (archived, or never written — e.g. an intent that is not on
chain yet) are reported but never extended. Restores stay reactive in
`StellarTxService.invokeContract`. Entries the protocol does not own are out
of scope.

All extensions respect `ONCHAIN_DRY_RUN` (simulate and report the fee only)
and the `onchain` kill-switch.

## Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `TTL_KEEPER_ENABLED` | `false` | Off by default; the keeper spends XLM. |
| `TTL_KEEPER_INTERVAL_MS` | `3600000` | One run per hour. |
| `TTL_KEEPER_THRESHOLD_LEDGERS` | `120960` | ~7 days at 5 s/ledger. |
| `TTL_KEEPER_EXTEND_TO_LEDGERS` | `518400` | ~30 days. Must exceed the threshold. Capped by the network's max TTL. |
| `TTL_KEEPER_DAILY_BUDGET_STROOPS` | `50000000` | 5 XLM per UTC day. |
| `TTL_KEEPER_MAX_KEYS_PER_TX` | `20` | Must stay within the network's per-transaction footprint limit. |
| `TTL_KEEPER_INTENT_KEY_VARIANT` | `Intent` | Must match the settlement contract's `DataKey` enum. |
| `TTL_KEEPER_BOND_KEY_VARIANT` | `Bond` | Must match the solver registry's `DataKey` enum. |

> **Check the key variants against the deployed contracts before enabling.**
> If they are wrong, every intent/bond key shows as `missing` in the report
> and is never extended. Instance and code keys do not depend on them.

The budget counter is in memory on the leader. After a failover the new
leader starts at zero, so the worst case is about twice the budget in one day.

## Report endpoint

```bash
# Scan now (read-only, submits nothing):
curl -H "x-admin-key: $ADMIN_KEY" https://api.example.com/api/v1/admin/soroban/ttl

# Last completed keeper run (no RPC calls):
curl -H "x-admin-key: $ADMIN_KEY" "https://api.example.com/api/v1/admin/soroban/ttl?cached=true"

# Run the keeper now (extends within the remaining budget; audited):
curl -X POST -H "x-admin-key: $ADMIN_KEY" https://api.example.com/api/v1/admin/soroban/ttl/run
```

Each entry carries `kind`, `contract`, `subject` (contract ID, WASM hash,
intent ID or solver address), `keyXdr`, `status`
(`ok` | `below_threshold` | `missing`), `liveUntilLedgerSeq`,
`remainingLedgers` and `remainingSecondsApprox`.

## Metrics and alerts

| Metric | Meaning |
|--------|---------|
| `vortex_soroban_ttl_remaining_ledgers{kind,contract}` | Minimum remaining TTL per kind; `-1` = an entry is missing |
| `vortex_soroban_ttl_keys_extended_total{kind}` | Keys extended (confirmed) |
| `vortex_soroban_ttl_extension_tx_total{result}` | `success` / `dry_run` / `over_budget` / `failed` |
| `vortex_soroban_ttl_budget_spent_stroops` | Spend in the current UTC day |
| `vortex_soroban_ttl_keeper_last_run_timestamp_seconds` | Last completed run |

Alerts (`ops/prometheus/rules/vortex-soroban-ttl.yml`):

- **VortexContractInstanceTtlLow** / **VortexContractCodeTtlLow** (page) —
  instance or code TTL below 7 days, or missing.
- **VortexTtlKeeperStale** (ticket) — no completed run for 3 hours.
- **VortexTtlKeeperBudgetExhausted** (ticket) — extensions skipped for budget.

## Responding

**Instance/code TTL low.**
1. `GET /api/v1/admin/soroban/ttl` — confirm which entry and how low.
2. Check the keeper is running: `vortex_soroban_ttl_keeper_last_run_timestamp_seconds`,
   leader election (`docs/runbooks/leader-election.md`), and
   `vortex_soroban_ttl_extension_tx_total{result="failed"}` plus logs tagged `[ttl-keeper]`.
3. If the budget is exhausted, raise `TTL_KEEPER_DAILY_BUDGET_STROOPS` and redeploy.
4. `POST /api/v1/admin/soroban/ttl/run` to extend immediately.
5. If the remaining TTL is `-1` the entry is archived: restore it with a
   `RestoreFootprint` transaction (the next contract call through
   `StellarTxService.invokeContract` does this automatically), then run the keeper.

**Budget exhausted.** Usually many intents crossing the threshold at once,
or fee spikes. Compare `vortex_soroban_ttl_budget_spent_stroops` with the
transaction count. Raise the budget, or raise `TTL_KEEPER_EXTEND_TO_LEDGERS`
so each entry needs extending less often.

**Rollback.** Set `TTL_KEEPER_ENABLED=false`. Nothing else depends on it.
