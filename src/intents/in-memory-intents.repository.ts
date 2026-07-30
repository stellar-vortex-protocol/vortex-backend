import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { IIntentsRepository } from "./intents.repository";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

/**
 * In-memory implementation of IIntentsRepository.
 *
 * Stores intents in a plain `Map` and seeds demo data on construction.
 * This is the adapter that ships with the current in-memory backend; it will
 * be replaced by a Prisma-backed adapter once the database work (issue #36)
 * lands, without any changes to IntentsService.
 */
@Injectable()
export class InMemoryIntentsRepository implements IIntentsRepository {
  private readonly store = new Map<string, Intent>();

  constructor() {
    this.seed();
  }

  save(intent: Intent): Intent {
    this.store.set(intent.intentId, intent);
    return intent;
  }

  findById(id: string): Intent | undefined {
    return this.store.get(id);
  }

  findAll(): Intent[] {
    return [...this.store.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  findByState(state: IntentState): Intent[] {
    return this.findAll().filter((i) => i.state === state);
  }

  findByUser(user: string): Intent[] {
    return this.findAll().filter((i) => i.user.toLowerCase() === user.toLowerCase());
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: Intent = { ...existing, ...patch };
    this.store.set(id, updated);
    return updated;
  }

  // ── seed ────────────────────────────────────────────────────────────────────

  private seed(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.store.set(intent.intentId, intent);
    }
  }
}
