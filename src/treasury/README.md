# Treasury Accounting Module

## Overview

The Treasury Accounting module provides automated reconciliation of protocol treasury balances against on-chain data. It aggregates fee accruals, slash proceeds, and refunds from internal ledgers and compares them daily against actual blockchain balances.

## Features

- **Fee Ledger Tracking**: Records all protocol fees collected from filled intents
- **Slash Ledger Tracking**: Records all slash proceeds from solver penalties
- **Refund Ledger Tracking**: Records all refunds issued to users
- **Daily Reconciliation**: Automated daily job that reconciles expected vs actual balances
- **Discrepancy Detection**: Flags unexplained discrepancies exceeding tolerance thresholds
- **Historical Snapshots**: Maintains daily snapshots for audit trails and reporting
- **Public API**: Exposes reconciliation data for governance and community dashboards

## Architecture

### Database Schema

```
treasury_snapshots
├─ snapshot_date (unique with asset)
├─ asset
├─ expected_balance (from ledgers)
├─ actual_balance (from blockchain)
├─ discrepancy (actual - expected)
├─ tolerance_threshold
├─ has_unexplained_discrepancy
├─ explanation
└─ breakdown (JSON: fees, slashes, refunds)

fee_ledger
├─ intent_id
├─ asset
├─ amount
├─ accrual_at
└─ tx_hash

slash_ledger
├─ solver_address
├─ asset
├─ amount
├─ slashed_at
├─ reason
└─ tx_hash

refund_ledger
├─ intent_id
├─ user_address
├─ asset
├─ amount
├─ issued_at
├─ reason
└─ tx_hash
```

### Service Components

**TreasuryService**
- Manages ledger entries (fees, slashes, refunds)
- Calculates expected balances from ledgers
- Fetches actual balances from Horizon/Soroban
- Performs reconciliation and generates snapshots
- Alerts on unexplained discrepancies
- Scheduled daily reconciliation via cron

**TreasuryController**
- `GET /api/v1/treasury/reconciliation` - Public summary endpoint
- `GET /api/v1/treasury/reconciliation/:asset` - Detailed asset view
- `POST /api/v1/treasury/reconciliation/trigger` - Manual trigger (admin)

## Configuration

### Environment Variables

```bash
# Treasury account public key
TREASURY_ADDRESS=GTREASURY...

# Horizon endpoint for balance queries
HORIZON_URL=https://horizon-testnet.stellar.org
```

### Tolerance Thresholds

Default thresholds are configured in `TreasuryService.constructor`:

```typescript
this.toleranceThresholds = new Map([
  ["native", 10000000n], // 1 XLM (7 decimals)
  ["USDC", 1000000n],     // 1 USDC (6 decimals)
]);
```

These can be customized per deployment environment or moved to database configuration.

## Usage

### Recording Ledger Entries

```typescript
// Record a fee from a filled intent
await treasuryService.recordFee({
  intentId: "intent-uuid",
  asset: "native",
  amount: "1000000", // 0.1 XLM in stroops
  accrualAt: new Date(),
  txHash: "transaction-hash",
});

// Record a slash from a solver penalty
await treasuryService.recordSlash({
  solverAddress: "GSOLVER...",
  asset: "native",
  amount: "50000000", // 5 XLM
  slashedAt: new Date(),
  reason: "Missed fill deadline",
  txHash: "transaction-hash",
});

// Record a refund to a user
await treasuryService.recordRefund({
  intentId: "intent-uuid",
  userAddress: "GUSER...",
  asset: "native",
  amount: "2000000", // 0.2 XLM
  issuedAt: new Date(),
  reason: "Failed transaction",
  txHash: "transaction-hash",
});
```

### Querying Reconciliation Data

```typescript
// Get summary for today
const summary = await treasuryService.getReconciliationSummary();

// Get summary for specific date
const summary = await treasuryService.getReconciliationSummary("2026-09-28");

// Get detailed view for an asset
const detail = await treasuryService.getReconciliationDetail("native", "2026-09-28");

// Manual reconciliation trigger
const results = await treasuryService.triggerReconciliation("native");
```

## Reconciliation Process

1. **Aggregate Ledgers** (00:00 UTC daily)
   - Sum all fees from `fee_ledger` for each asset
   - Sum all slashes from `slash_ledger` for each asset
   - Sum all refunds from `refund_ledger` for each asset
   - Calculate net expected: `fees + slashes - refunds`

2. **Fetch Actual Balances**
   - Query Horizon API for Stellar account balances
   - Query Soroban contracts for SAC token balances
   - Parse and normalize to base units

3. **Compare & Detect Discrepancies**
   - Calculate: `discrepancy = actualBalance - expectedBalance`
   - Check if `abs(discrepancy) > toleranceThreshold`
   - Flag as unexplained if threshold exceeded

4. **Generate Snapshot**
   - Create/update `treasury_snapshots` record
   - Store breakdown of fees, slashes, refunds
   - Generate human-readable explanation

5. **Alert on Issues**
   - Log warnings for discrepancies within tolerance
   - Log critical alerts for unexplained discrepancies
   - TODO: Integration with PagerDuty/Slack/monitoring systems

## API Endpoints

### GET /api/v1/treasury/reconciliation

Public endpoint returning daily reconciliation summary.

**Response:**
```json
{
  "date": "2026-09-28",
  "assets": [
    {
      "asset": "native",
      "expectedBalance": "1000000000",
      "actualBalance": "1000500000",
      "discrepancy": "500000",
      "discrepancyPercentage": 0.05,
      "hasUnexplainedDiscrepancy": false,
      "explanation": "Discrepancy within tolerance threshold...",
      "breakdown": {
        "fees": "800000000",
        "slashes": "300000000",
        "refunds": "100000000"
      }
    }
  ],
  "totalDiscrepancies": 2,
  "assetsWithUnexplainedDiscrepancies": 0,
  "lastReconciliationAt": "2026-09-28T00:00:00.000Z"
}
```

### GET /api/v1/treasury/reconciliation/:asset

Detailed reconciliation view including recent transactions.

**Response:**
```json
{
  "snapshotDate": "2026-09-28",
  "asset": "native",
  "expectedBalance": "1000000000",
  "actualBalance": "1000500000",
  "discrepancy": "500000",
  "discrepancyPercentage": 0.05,
  "toleranceThreshold": "10000000",
  "hasUnexplainedDiscrepancy": false,
  "explanation": "Discrepancy within tolerance threshold...",
  "breakdown": {
    "fees": "800000000",
    "slashes": "300000000",
    "refunds": "100000000"
  },
  "recentTransactions": [
    {
      "type": "fee",
      "amount": "1000000",
      "timestamp": "2026-09-27T15:30:00.000Z",
      "reference": "intent-uuid"
    },
    {
      "type": "slash",
      "amount": "50000000",
      "timestamp": "2026-09-27T14:20:00.000Z",
      "reference": "solver-address"
    }
  ]
}
```

### POST /api/v1/treasury/reconciliation/trigger

Admin endpoint to manually trigger reconciliation.

**Query Parameters:**
- `asset` (optional): Specific asset to reconcile

**Response:**
```json
{
  "message": "Reconciliation completed for native",
  "results": [
    {
      "asset": "native",
      "hasUnexplainedDiscrepancy": false,
      "discrepancy": "500000",
      "discrepancyPercentage": 0.05
    }
  ]
}
```

## Testing

Comprehensive test suite in `treasury.service.spec.ts`:

- Ledger entry recording (fees, slashes, refunds)
- Expected balance calculation from ledgers
- Discrepancy detection (within/exceeding tolerance)
- Reconciliation summary generation
- Detailed reconciliation views
- Edge cases (empty ledgers, negative discrepancies)

Run tests:
```bash
npm test -- treasury.service.spec.ts
```

## Integration Points

### Intents Service
When an intent is filled, record the fee in the fee ledger:
```typescript
if (intent.feeAmount) {
  await treasuryService.recordFee({
    intentId: intent.intentId,
    asset: intent.dstToken.asset,
    amount: intent.feeAmount,
    accrualAt: new Date(),
    txHash: intent.txHash,
  });
}
```

### Solver Registry Service
When a solver is slashed, record in the slash ledger:
```typescript
await treasuryService.recordSlash({
  solverAddress: solver.address,
  asset: slashParams.asset,
  amount: slashParams.amount,
  slashedAt: new Date(),
  reason: slashParams.reason,
  txHash: slashResult.txHash,
});
```

### Refund Service (Future)
When issuing refunds, record in the refund ledger:
```typescript
await treasuryService.recordRefund({
  intentId: intent.intentId,
  userAddress: intent.user,
  asset: refundAsset,
  amount: refundAmount,
  issuedAt: new Date(),
  reason: "Transaction failed",
  txHash: refundTxHash,
});
```

## Future Enhancements

1. **Alert Integration**
   - PagerDuty integration for critical discrepancies
   - Slack notifications for daily summaries
   - Email reports for governance

2. **Dashboard**
   - Grafana panels for treasury metrics
   - Historical trend visualization
   - Real-time balance monitoring

3. **Multi-Asset Support**
   - Soroban SAC balance queries
   - Cross-chain asset tracking
   - Configurable tolerance per asset

4. **Automated Remediation**
   - Investigate and auto-resolve common discrepancies
   - In-flight settlement tracking
   - Pending transaction awareness

5. **Audit Trail**
   - Immutable ledger with cryptographic verification
   - Export to external audit tools
   - Compliance reporting

## Maintenance

### Adding New Assets

1. Update tolerance thresholds in `TreasuryService.constructor`
2. Ensure asset identifier format matches ledger entries
3. Test balance fetching for the new asset type

### Adjusting Tolerance Thresholds

```typescript
// In TreasuryService constructor or via config
this.toleranceThresholds.set("NEWTOKEN", 5000000n);
```

### Investigating Discrepancies

1. Query detailed view: `GET /api/v1/treasury/reconciliation/:asset`
2. Review `recentTransactions` for unexpected activity
3. Check blockchain explorer for treasury account
4. Cross-reference with intent/solver activity logs
5. Update `explanation` field if resolved

## License

See project LICENSE file.
