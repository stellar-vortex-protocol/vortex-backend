# Runbook: Event Backfill After Ledger Gap

## Overview

The live ingestion cursor (`nextStartLedger`) advances by one ledger per 10-second poll. Soroban RPC nodes retain only a limited window of events (~17 k ledgers ≈ 1 day). If the backend is offline longer than the retention window, the RPC will no longer serve the missed events and intents can be left in stale states.

This runbook covers:
1. Detecting whether a gap has occurred.
2. Running a resumable backfill from an archival source.
3. Verifying the result.

**Related issues:** #391 (BackfillService), #390 (EventDecoderRegistry), #392 (ReconcilerService).

---

## Prerequisites

- `SETTLEMENT_CONTRACT_ID` is set in the environment.
- Either `SOROBAN_RPC_URL` (for gaps within the retention window) or `ARCHIVAL_RPC_URL` (for deeper gaps) is configured.
- The `processed_events` and `dead_letter_events` tables exist (run `npm run db:migrate`).

---

## Step 1 — Detect the Gap

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
SETTLEMENT_CONTRACT_ID=C... \
DATABASE_URL=postgresql://... \
tsx scripts/backfill-events.ts --gap-check
```

Sample output:

```
=== Gap Detection Report ===
  Cursor ledger   : 1000000
  Oldest RPC ledger: 1015000
  Latest ledger   : 1100000
  Has gap         : true
  Gap size        : 15000 ledgers
  ⚠️  Backfill required. Run with --from and --to to fill the gap.
```

---

## Step 2 — Configure an Archival Source (if gap > retention window)

For deep gaps, set `ARCHIVAL_RPC_URL` to a history-archive-backed RPC endpoint:

```bash
export ARCHIVAL_RPC_URL=https://your-archival-rpc.example.com
```

Providers with archival support include Horizon's Soroban-compatible RPC, Galexie, and some third-party RPC providers — see [Stellar Indexers documentation](https://developers.stellar.org/docs/data/indexers) for options.

---

## Step 3 — Dry-run First

Always run with `--dry-run` before committing writes:

```bash
tsx scripts/backfill-events.ts \
  --from 1000000 --to 1015000 \
  --dry-run \
  --page-size 200
```

Review the output for unexpected dead-letter events. A dead-letter means a known event topic failed schema validation — investigate before proceeding.

---

## Step 4 — Run the Backfill

```bash
tsx scripts/backfill-events.ts \
  --from 1000000 --to 1015000 \
  --page-size 200 \
  --rate-limit-ms 250
```

The script writes an idempotency record to `processed_events` for each event. A crash mid-run is safe: use `--resume` to continue from where it left off:

```bash
tsx scripts/backfill-events.ts \
  --from 1000000 --to 1015000 \
  --resume
```

---

## Step 5 — Verify

After the backfill completes:

1. Re-run `--gap-check` to confirm the cursor is no longer behind the oldest ledger.
2. Check for dead-letter events:
   ```sql
   SELECT raw_topic, error, COUNT(*) FROM dead_letter_events
   WHERE occurred_at > now() - interval '2 hours'
   GROUP BY raw_topic, error;
   ```
3. Run a reconciliation dry-run to verify intent states are consistent:
   ```
   POST /api/v1/reconcile?dryRun=true   (when the admin endpoint is exposed)
   ```
   or check the reconciler log output for divergences.

---

## Trigger via API (admin-only)

When `SETTLEMENT_CONTRACT_ID` is configured, a backfill can also be triggered programmatically by calling `BackfillService.run(...)` from the application. There is no HTTP surface for this yet — operators must use the CLI script above.

---

## Fixture Regeneration (for decoder tests)

The golden-file fixtures in `src/soroban/events/__fixtures__/events.json` use native JS representations of ScVal topics and values. To regenerate them from real testnet events:

1. Set `SOROBAN_RPC_URL` and `SETTLEMENT_CONTRACT_ID` to a testnet deployment.
2. Run the backfill for a small ledger range with `VERBOSE=1`:
   ```bash
   VERBOSE=1 tsx scripts/backfill-events.ts --from X --to X+100 --dry-run
   ```
3. Copy the printed event data into `__fixtures__/events.json`.
4. Update `expectedPayload` fields in the fixture to match the decoded values your test expects.
5. Commit the updated fixture file. The decoder unit tests in `src/soroban/events/` will use it automatically.

> Keep the fixture file small (one event per topic); the goal is a representative sample for each schema version, not a full event replay.

---

## Runbook Checklist

- [ ] Gap detected with `--gap-check`
- [ ] Archival source configured (if needed)
- [ ] Dry-run completed with zero unexpected dead-letters
- [ ] Backfill run (or resumed if interrupted)
- [ ] Dead-letter table checked
- [ ] Reconciler reported zero amount-mismatch divergences
- [ ] Gap re-checked and confirmed closed
