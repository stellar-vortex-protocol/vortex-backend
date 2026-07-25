import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SorobanService } from "./soroban.service";
import { IntentsGateway } from "../intents/intents.gateway";

const POLL_INTERVAL_MS = 5_000;

/**
 * Polls Soroban RPC for events emitted by the settlement contract and
 * forwards them onto IntentsGateway.broadcast(), so state changes made by
 * other actors calling the contract directly (not just this backend's own
 * HTTP handlers) still reach WebSocket subscribers.
 */
@Injectable()
export class EventIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventIngestionService.name);
  private readonly contractId: string;

  private timer?: NodeJS.Timeout;
  private cursor?: string;
  private nextStartLedger?: number;
  private polling = false;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly sorobanService: SorobanService,
    private readonly intentsGateway: IntentsGateway,
  ) {
    this.contractId = configService.get("stellar.settlementContractId", { infer: true });
  }

  async onModuleInit() {
    if (!this.contractId) {
      this.logger.warn("SETTLEMENT_CONTRACT_ID not configured — event ingestion disabled");
      return;
    }

    try {
      const { sequence } = await this.sorobanService.getLatestLedger();
      this.nextStartLedger = sequence;
    } catch (err) {
      this.logger.error(`Could not resolve a starting ledger, will retry on next poll: ${errorMessage(err)}`);
    }

    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.polling) return; // previous poll still in flight, skip this tick
    this.polling = true;

    try {
      const response = await this.sorobanService.getEvents({
        filters: [{ type: "contract", contractIds: [this.contractId] }],
        cursor: this.cursor,
        startLedger: this.cursor ? undefined : this.nextStartLedger,
        limit: 100,
      });

      for (const event of response.events) {
        this.cursor = event.pagingToken;
        if (event.inSuccessfulContractCall) this.handleEvent(event);
      }
    } catch (err) {
      this.logger.error(`Event poll failed, will retry: ${errorMessage(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private handleEvent(event: SorobanRpc.Api.EventResponse) {
    const [topicSymbol, ...restTopics] = event.topic.map((scv) => scValToNative(scv));

    this.intentsGateway.broadcast({
      type: `chain_${String(topicSymbol ?? "event").toLowerCase()}`,
      contractId: this.contractId,
      ledger: event.ledger,
      txHash: event.txHash,
      topics: restTopics,
      data: scValToNative(event.value),
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
