import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SorobanService } from './soroban.service';
import { Intent } from '../intents/entities/intent.entity';

/**
 * Builds and (optionally) simulates the Soroban invocation that would settle an
 * intent on-chain. `buildOutboxInvocation` is a pure builder used by the outbox
 * relay; `SettlementCostEstimator` reuses it as a read-only preflight so intent
 * creation/quoting can disclose an estimated settlement cost up front.
 */
@Injectable()
export class OutboxOperations {
  private readonly logger = new Logger(OutboxOperations.name);

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Build the `create_intent`/`fill_intent` invocation payload for an intent
   * without enqueueing it. Pure: no side effects, no lease consumption.
   */
  buildOutboxInvocation(intent: Intent): {
    contractId: string;
    method: string;
    args: unknown[];
  } {
    const contractId = this.configService.get<string>(
      'SETTLEMENT_CONTRACT_ID',
    );
    if (!contractId) {
      throw new Error('SETTLEMENT_CONTRACT_ID is not configured');
    }

    const method = intent.status === 'filled' ? 'fill_intent' : 'create_intent';
    return {
      contractId,
      method,
      args: [
        intent.id,
        intent.maker ?? null,
        intent.amountIn ?? null,
        intent.amountOut ?? null,
      ],
    };
  }
}

/**
 * Advisory, read-only settlement-cost preflight estimator.
 *
 * Builds the would-be outbox invocation for an intent and simulates it against
 * a throwaway/sandbox envelope using a configured read-only simulation account
 * (never a channel-pool account, so no lease is consumed). Any failure or
 * missing configuration yields `undefined` — this path must never block intent
 * creation or quoting.
 */
@Injectable()
export class SettlementCostEstimator {
  private readonly logger = new Logger(SettlementCostEstimator.name);

  constructor(
    private readonly outboxOperations: OutboxOperations,
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Estimate the on-chain settlement cost (resource fee + inclusion fee) in
   * stroops for a would-be intent. Returns `undefined` when the settlement
   * contract is unconfigured or simulation fails.
   */
  async estimate(intent: Intent): Promise<number | undefined> {
    try {
      const contractId = this.configService.get<string>(
        'SETTLEMENT_CONTRACT_ID',
      );
      if (!contractId) {
        return undefined;
      }

      const simulationAccount = this.configService.get<string>(
        'SETTLEMENT_SIMULATION_ACCOUNT',
      );
      if (!simulationAccount) {
        return undefined;
      }

      const invocation = this.outboxOperations.buildOutboxInvocation(intent);

      const simulation = await this.sorobanService.simulateTransaction({
        sourceAccount: simulationAccount,
        contractId: invocation.contractId,
        method: invocation.method,
        args: invocation.args,
      });

      const resourceFee = Number(simulation?.minResourceFee ?? 0);
      const inclusionFee = Number(simulation?.inclusionFee ?? 0);
      const total = resourceFee + inclusionFee;

      if (!Number.isFinite(total) || total <= 0) {
        return undefined;
      }

      return total;
    } catch (error) {
      this.logger.debug(
        `Settlement cost estimation skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }
}
