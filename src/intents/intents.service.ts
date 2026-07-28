import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

/** How often (ms) to emit a store-size log. Default: 60 s. */
const STORE_SIZE_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class IntentsService implements OnModuleDestroy {
  private readonly logger = new Logger(IntentsService.name);
  private readonly intents = new Map<string, Intent>();
  private readonly sizeLogTimer: NodeJS.Timeout;

  constructor() {
    this.seed();
    this.sizeLogTimer = setInterval(() => this.logStoreSize(), STORE_SIZE_LOG_INTERVAL_MS);
    // Allow the process to exit even if the timer is still active.
    this.sizeLogTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sizeLogTimer);
  }

  /** Logs the current intent map size so unbounded growth is observable. */
  logStoreSize(): void {
    this.logger.log(`[store-monitor] intents map size: ${this.intents.size}`);
  }

  create(data: Omit<Intent, "intentId" | "createdAt" | "state">): Intent {
    const now = Math.floor(Date.now() / 1000);
    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: data.deadline ?? now + 1800,
    };
    this.intents.set(intent.intentId, intent);
    return intent;
  }

  get(id: string): Intent | undefined {
    return this.intents.get(id);
  }

  getAll(): Intent[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getByState(state: IntentState): Intent[] {
    return this.getAll().filter((i) => i.state === state);
  }

  getByUser(user: string): Intent[] {
    return this.getAll().filter((i) => i.user.toLowerCase() === user.toLowerCase());
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.intents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.intents.set(id, updated);
    return updated;
  }

  private seed() {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.intents.set(intent.intentId, intent);
    }
  }
}
