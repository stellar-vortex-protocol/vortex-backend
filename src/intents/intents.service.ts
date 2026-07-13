import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

@Injectable()
export class IntentsService {
  private readonly intents = new Map<string, Intent>();

  constructor() {
    this.seed();
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
