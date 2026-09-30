/**
 * Treasury Integration Examples
 * 
 * This file shows how to integrate the TreasuryService with other modules
 * to automatically track fees, slashes, and refunds.
 */

import { Injectable } from "@nestjs/common";
import { TreasuryService } from "./treasury.service";

/**
 * Example: Integrating with IntentsService
 * 
 * When an intent is filled, record the fee in the treasury ledger.
 */
@Injectable()
export class IntentsServiceWithTreasury {
  constructor(private readonly treasuryService: TreasuryService) {}

  async markIntentAsFilled(
    intentId: string,
    fillAmount: string,
    feeAmount: string,
    txHash: string,
    dstAsset: string,
  ) {
    // ... existing intent update logic ...

    // Record fee in treasury ledger
    if (feeAmount && BigInt(feeAmount) > 0n) {
      await this.treasuryService.recordFee({
        intentId,
        asset: dstAsset,
        amount: feeAmount,
        accrualAt: new Date(),
        txHash,
      });
    }
  }
}

/**
 * Example: Integrating with SolverRegistryService
 * 
 * When a solver is slashed, record the slash in the treasury ledger.
 */
@Injectable()
export class SolverRegistryServiceWithTreasury {
  constructor(private readonly treasuryService: TreasuryService) {}

  async slashSolver(
    solverAddress: string,
    asset: string,
    amount: string,
    reason: string,
  ) {
    // ... existing slash logic (on-chain transaction) ...
    const txHash = "..."; // from blockchain response

    // Record slash in treasury ledger
    await this.treasuryService.recordSlash({
      solverAddress,
      asset,
      amount,
      slashedAt: new Date(),
      reason,
      txHash,
    });
  }
}

/**
 * Example: Integrating with a future RefundsService
 * 
 * When issuing a refund to a user, record it in the treasury ledger.
 */
@Injectable()
export class RefundsServiceWithTreasury {
  constructor(private readonly treasuryService: TreasuryService) {}

  async issueRefund(
    intentId: string,
    userAddress: string,
    asset: string,
    amount: string,
    reason: string,
  ) {
    // ... existing refund logic (on-chain transaction) ...
    const txHash = "..."; // from blockchain response

    // Record refund in treasury ledger
    await this.treasuryService.recordRefund({
      intentId,
      userAddress,
      asset,
      amount,
      issuedAt: new Date(),
      reason,
      txHash,
    });
  }
}

/**
 * Example: Event-driven integration using EventEmitter
 * 
 * Listen for domain events and automatically record treasury entries.
 */
@Injectable()
export class TreasuryEventListener {
  constructor(private readonly treasuryService: TreasuryService) {}

  // Called when IntentFilledEvent is emitted
  async onIntentFilled(event: {
    intentId: string;
    feeAmount: string;
    dstAsset: string;
    txHash: string;
  }) {
    if (event.feeAmount && BigInt(event.feeAmount) > 0n) {
      await this.treasuryService.recordFee({
        intentId: event.intentId,
        asset: event.dstAsset,
        amount: event.feeAmount,
        accrualAt: new Date(),
        txHash: event.txHash,
      });
    }
  }

  // Called when SolverSlashedEvent is emitted
  async onSolverSlashed(event: {
    solverAddress: string;
    asset: string;
    amount: string;
    reason: string;
    txHash: string;
  }) {
    await this.treasuryService.recordSlash({
      solverAddress: event.solverAddress,
      asset: event.asset,
      amount: event.amount,
      slashedAt: new Date(),
      reason: event.reason,
      txHash: event.txHash,
    });
  }

  // Called when RefundIssuedEvent is emitted
  async onRefundIssued(event: {
    intentId: string;
    userAddress: string;
    asset: string;
    amount: string;
    reason: string;
    txHash: string;
  }) {
    await this.treasuryService.recordRefund({
      intentId: event.intentId,
      userAddress: event.userAddress,
      asset: event.asset,
      amount: event.amount,
      issuedAt: new Date(),
      reason: event.reason,
      txHash: event.txHash,
    });
  }
}

/**
 * Example: Admin dashboard queries
 */
@Injectable()
export class TreasuryDashboard {
  constructor(private readonly treasuryService: TreasuryService) {}

  async getDailySummary(date?: string) {
    return this.treasuryService.getReconciliationSummary(date);
  }

  async getAssetBreakdown(asset: string, date?: string) {
    return this.treasuryService.getReconciliationDetail(asset, date);
  }

  async triggerManualReconciliation() {
    return this.treasuryService.triggerReconciliation();
  }

  async checkForDiscrepancies() {
    const summary = await this.treasuryService.getReconciliationSummary();
    return summary.assets.filter((a) => a.hasUnexplainedDiscrepancy);
  }
}

/**
 * Example: Monitoring and alerting
 */
@Injectable()
export class TreasuryMonitoring {
  constructor(private readonly treasuryService: TreasuryService) {}

  async checkHealthAndAlert() {
    const summary = await this.treasuryService.getReconciliationSummary();
    
    if (summary.assetsWithUnexplainedDiscrepancies > 0) {
      const problematicAssets = summary.assets.filter(
        (a) => a.hasUnexplainedDiscrepancy,
      );

      for (const asset of problematicAssets) {
        const severity =
          Math.abs(asset.discrepancyPercentage) > 5 ? "critical" : "warning";
        
        // Send alert to monitoring system
        console.error(`[${severity.toUpperCase()}] Treasury discrepancy detected:`, {
          asset: asset.asset,
          discrepancy: asset.discrepancy,
          percentage: asset.discrepancyPercentage,
          explanation: asset.explanation,
        });

        // TODO: Integrate with actual alerting system
        // await pagerDuty.trigger({ ... });
        // await slack.sendMessage({ ... });
      }
    }

    return {
      healthy: summary.assetsWithUnexplainedDiscrepancies === 0,
      summary,
    };
  }
}
