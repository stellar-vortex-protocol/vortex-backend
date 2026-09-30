# Runbook: Soroban contract upgrades

Issue #402. How the backend detects in-place WASM upgrades of the settlement
and solver-registry contracts, what read-only mode means, and how to roll a
contract upgrade out safely.

## How version gating works

Soroban contracts can be upgraded in place: the contract ID stays the same
while the WASM behind it changes. The backend encodes calls for a specific
ABI, so it tracks the deployed WASM hash and only writes when that hash is on
an allow-list.

- `SUPPORTED_CONTRACT_VERSIONS` in
  `src/soroban/contracts/contract-versions.ts` maps each contract's known
  WASM hashes to an ABI version (`settlement-v1`, `solver-registry-v1`).
- Each ABI version has a codec (`SETTLEMENT_CODECS`,
  `SOLVER_REGISTRY_CODECS`) that encodes the calls. Clients ask
  `ContractVersionService` for the deployed ABI and use that codec.
- `ContractVersionService` reads each configured contract's instance entry
  (`getLedgerEntries`) every 60 s. Before every write, it re-reads the hash
  if the cached one is older than 60 s, so an upgrade is caught before the
  next write rather than up to a poll interval later.
- Contracts that emit an `upgrade` / `upgraded` / `contract_upgraded` event
  trigger an immediate re-check through event ingestion.

### Statuses

| Status | Meaning | Writes |
|---|---|---|
| `unconfigured` | No contract ID set; the on-chain path is off | n/a |
| `pending` | Not checked yet (boot) | Blocked |
| `supported` | Hash maps to an ABI with a codec | Allowed |
| `unknown_hash` | Hash is not in `SUPPORTED_CONTRACT_VERSIONS` | **Blocked** |
| `unreachable` | The instance could not be read (RPC error, not deployed) | **Blocked** |

When any configured contract is not `supported`, the backend is in
**read-only mode** for that contract:

- `POST /api/v1/intents` with `ONCHAIN_INTENTS_ENABLED=true` returns `503`
  with the contract, status and hash in the body.
- Sweeper slashes are not submitted. The intent is still marked `slashed`
  locally, and the log records `blocked slash … read-only mode`.
- Reads keep working. `/health/ready` does not fail, so the pods stay in
  rotation.

## Where to look

- `GET /health` and `GET /api/v1/chain/network` → `readOnly` and
  `contracts.<name>` (`status`, `wasmHash`, `abiVersion`, `checkedAt`,
  `previousWasmHash`, `upgradedAt`, `error`).
- Metrics:
  - `vortex_contract_version_supported{contract}`: 1 or 0. **Alert on 0.**
  - `vortex_contract_upgrades_total{contract,source}`: detected upgrades.
  - `vortex_contract_writes_blocked_total{contract}`: refused writes.
- Logs: `[contract-version] ALERT <contract> … is unknown_hash|unreachable`
  at `error` level, which reaches Sentry and log shipping.
- History: table `contract_upgrades` (one row per detected upgrade, with the
  previous and new hash, ABI version, `poll` or `event` source, ledger, and
  tx hash).

Suggested alert:

```
min by (contract) (vortex_contract_version_supported) == 0  for 2m
```

## Rolling out a contract upgrade

1. **Get the new hash** from the contract release, or after installing it:
   `stellar contract install --wasm <file>` prints it. For a deployed
   contract, use `stellar contract info wasm-hash --id <CONTRACT_ID>`.
2. **Decide compatibility.**
   - Same ABI (bug fix, no interface change): add the hash with the
     *existing* ABI version.
   - Changed ABI: add a new ABI version type, a new codec entry, and tests
     for it. Never edit an existing codec in place: rollbacks rely on it.
3. **Open a PR** adding the hash to `SUPPORTED_CONTRACT_VERSIONS`. Keep the
   old hash too, so the backend works both before and after the upgrade.
4. **Deploy the backend** with the new hash before upgrading the contract.
5. **Upgrade the contract** on-chain. Within 60 s (or immediately, if the
   contract emits an upgrade event) `/health` should show the new
   `wasmHash`, `status: supported`, and `previousWasmHash` set to the old
   hash. A row appears in `contract_upgrades`.
6. **After the soak**, a follow-up PR may remove the old hash.

## If read-only mode triggers unexpectedly

1. Check `contracts.<name>` in `/health`.
   - `unknown_hash`: an upgrade shipped without step 4. Either deploy a
     backend that knows the hash (after confirming ABI compatibility) or
     roll the contract back to the previous WASM. The backend returns to
     `supported` on its next check, with no restart needed.
   - `unreachable`: check the RPC endpoint (`GET /api/v1/chain/health`) and
     the `error` field. Writes resume on their own once the instance is
     readable again.
2. Intents created while read-only were rejected with `503` and were never
   persisted, so clients can retry once the contract is supported again.
3. Slashes skipped while read-only are visible in the logs and the
   `slashed` intents. Replay them with the solver-registry tooling once the
   version is supported.
