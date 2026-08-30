import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { promises as fs } from "fs";
import { join } from "path";
import { IntentsGateway } from "../intents/intents.gateway";
import { IntentsService } from "../intents/intents.service";
import { SorobanService } from "./soroban.service";

interface IntentFilledEvent {
  ledger?: number;
  transactionHash?: string;
  txHash?: string;
  topics?: unknown[];
  topic?: unknown[];
  data?: unknown;
  [key: string]: unknown;
}

@Injectable()
export class EventIngestionService implements OnModuleInit {
  private readonly logger = new Logger(EventIngestionService.name);
  private readonly cursorPath = join(process.cwd(), ".data", "soroban-event-cursor.json");
  private nextStartLedger?: number;
  private polling = false;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  async onModuleInit() {
    try {
      const saved = JSON.parse(await fs.readFile(this.cursorPath, "utf8")) as { nextStartLedger?: number };
      if (Number.isInteger(saved.nextStartLedger)) this.nextStartLedger = saved.nextStartLedger;
    } catch {
      // A missing cursor intentionally starts at the latest ledger on first deployment.
    }
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const startLedger = this.nextStartLedger ?? (await this.sorobanService.getLatestLedger()).sequence;
      const response: any = await this.sorobanService.getEvents(startLedger);
      for (const event of response.events ?? []) {
        if (event.topic?.[0]?.value === "intent_filled" || event.name === "intent_filled") {
          await this.handleIntentFilled(event);
        }
      }
      const latest = response.latestLedger ?? response.latestLedgerSequence ?? startLedger;
      this.nextStartLedger = Math.max(startLedger, latest + 1);
      await this.persistCursor();
    } finally {
      this.polling = false;
    }
  }

  async handleIntentFilled(event: IntentFilledEvent) {
    const topicValues = (event.topics ?? event.topic ?? []).map((value: any) => value?.value ?? value);
    const intentIndex = topicValues[0] === "intent_filled" ? 1 : 0;
    const intentId = String(topicValues[intentIndex] ?? "");
    const fillValue: any = event.data ?? topicValues[intentIndex + 1] ?? "0";
    const fillAmount = String(fillValue?.value ?? fillValue);
    const txHash = event.transactionHash ?? event.txHash;
    if (!intentId) return;

    const updated = this.intentsService.reconcileFilled(intentId, fillAmount, txHash);
    if (!updated) {
      this.logger.warn(`Ignoring intent_filled for unknown local intent ${intentId}`);
      return;
    }
    this.intentsGateway.broadcast({
      type: "intent_filled",
      intentId,
      fillAmount,
      txHash,
    });
  }

  private async persistCursor() {
    await fs.mkdir(join(process.cwd(), ".data"), { recursive: true });
    await fs.writeFile(this.cursorPath, JSON.stringify({ nextStartLedger: this.nextStartLedger }), "utf8");
  }
}
