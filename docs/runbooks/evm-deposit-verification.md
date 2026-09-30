# Runbook: EVM source-deposit verification

Issue #403. Before an intent from an EVM chain is offered to solvers, the
backend confirms that the user's escrow deposit exists on the source chain
and is final enough to rely on.

## Behaviour

With `EVM_DEPOSIT_VERIFICATION_ENABLED=true`:

- New intents with `srcChain` in `ethereum | base | polygon | arbitrum |
  optimism | avalanche` are created `open` but with `srcVerified: false`
  (`srcVerification.status: "pending"`).
- Unverified intents are:
  - hidden from `GET /api/v1/intents/open` (pass `includeUnverified=true` to
    see them), from the solver WS snapshot, and from
    `GET /api/v1/solvers/:address/eligible-intents`;
  - rejected by `POST /api/v1/intents/:id/accept` with `409`.
- `SourceDepositVerificationService` checks due intents every 15 s. When a
  deposit verifies, it broadcasts `intent_src_verified` (with the full
  intent) on the WS feed, and solvers can then accept it.
- Stellar-source intents, and every intent while the flag is off, are
  created with `srcVerified: true` and status `skipped`.
- Intents that existed before the migration are `grandfathered` (verified).

### What "verified" means

`EvmDepositVerifier` finds the escrow's event:

```solidity
event Deposited(bytes32 indexed intentId, address indexed token,
                address indexed depositor, uint256 amount, string user);
```

`intentId` is `keccak256(utf8(intent.intentId))` and `user` is the intent's
`user` field. The escrow contract is maintained outside this repo and **must**
emit exactly this event. `test/evm/fixtures/MockEscrow.sol` is the reference
used in tests.

The log is located from the receipt of `srcTxHash` when the client supplied
one on `POST /intents` (cheapest). Otherwise the verifier searches the last
`EVM_LOG_LOOKBACK_BLOCKS` blocks by the indexed intent ID. The intent is
verified only if:

1. `token` equals `srcToken.address`, and `user` equals the intent's user
   (case-insensitive).
2. `amount ≥ srcAmount × (1 − EVM_TRANSFER_FEE_TOLERANCE_BPS / 10 000)`.
   Fee-on-transfer tokens deliver less than was sent. The received amount is
   recorded in `srcVerification.receivedAmount` either way.
3. The log's block meets the chain's confirmation policy:

| Chain | Policy |
|---|---|
| ethereum | 12 blocks deep |
| polygon | 128 blocks deep |
| base, optimism, arbitrum | at or below the `safe` head (batch posted to L1) |
| avalanche | 1 block (Snowman finality) |

The policies live in `CONFIRMATION_POLICIES` in
`src/chains/evm/evm-chains.ts`.

### Statuses (`srcVerification.status`)

| Status | Meaning | Next check |
|---|---|---|
| `pending` | Deposit found but not deep enough, or the chain is not configured | Backoff |
| `not_found` | No matching log yet | Backoff |
| `mismatch` | Wrong token, user or amount, or the deposit tx reverted | Backoff (a top-up can fix it) |
| `verified` | All checks passed | Re-checked every 60 s while `open` |
| `reorged` | A previously located deposit is no longer canonical | Backoff |

### Reorgs

Verified intents that are still `open` are re-verified every 60 s. If the
deposit's log disappears, or its block drops below the confirmation depth
after a reorg, the intent reverts to `srcVerified: false` and the feed
broadcasts `intent_src_unverified`. Solvers should drop it. Once an intent is
accepted it is no longer re-checked; the confirmation depth is what makes
that safe.

### Retries and RPC limits

Unverified intents back off 15 s → 30 s → … up to 10 min. After an RPC
rate-limit response (HTTP 429 / JSON-RPC `-32005`) the wait is multiplied by
4. At most 4 intents are verified concurrently. viem also retries transient
HTTP failures twice before the service sees an error. The queue is rebuilt
from the store every tick, so restarts lose nothing, and replicas racing on
the same intent are safe because results are written with optimistic
concurrency (issue #405).

## Configuration

| Variable | Example |
|---|---|
| `EVM_DEPOSIT_VERIFICATION_ENABLED` | `true` |
| `EVM_RPC_URLS` | `{"ethereum":"https://…","base":"https://…"}` |
| `EVM_ESCROW_ADDRESSES` | `{"ethereum":"0x…","base":"0x…"}` |
| `EVM_TRANSFER_FEE_TOLERANCE_BPS` | `0` (exact) |
| `EVM_LOG_LOOKBACK_BLOCKS` | `10000` |

A chain missing from either map keeps its intents `pending` with detail
`no RPC URL or escrow address configured`.

## Monitoring

- `vortex_src_verifications_total{chain,status}`: outcome rate. A growing
  `mismatch` rate usually means client bugs or an escrow ABI change.
- `vortex_src_verification_errors_total{chain,reason}`: `rate_limited`
  means the RPC plan needs more capacity.
- `vortex_src_verification_queue_size`: unverified open intents. It should
  stay near the rate of new EVM intents × time to finality.

## Rollback

- Setting `EVM_DEPOSIT_VERIFICATION_ENABLED=false` stops verification, but
  intents already created as `pending` stay hidden. To release them after
  confirming the deposits manually:
  ```sql
  UPDATE intents SET src_verified = true,
    src_verification = jsonb_build_object('status','skipped','checkedAt',EXTRACT(EPOCH FROM NOW())::bigint,'detail','verification disabled')
  WHERE state = 'open' AND NOT src_verified;
  ```
- Schema rollback: `prisma/migrations/20260929000002_intent_src_verification/down.sql`.
