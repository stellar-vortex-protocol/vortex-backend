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

  /**
   * Atomically accept an intent only if it is currently "open".
   * Mirrors the DB pattern: UPDATE intents SET state='accepted' WHERE id=$1 AND state='open' RETURNING *
   * Returns null when the intent is not found or is not in the "open" state (already taken).
   */
  acceptIfOpen(id: string, solver: string): Intent | null {
    const existing = this.intents.get(id);
    if (!existing || existing.state !== "open") return null;

    const now = Math.floor(Date.now() / 1000);
    const updated: Intent = {
      ...existing,
      state: "accepted",
      solver,
      deadline: now + 300,
    };
    this.intents.set(id, updated);
    return updated;
  }

  /**
   * Atomically fill an intent only if it is currently "accepted" by the given solver.
   * Mirrors the DB pattern:
   *   UPDATE intents SET state='filled', ... WHERE id=$1 AND state='accepted' AND solver=$2 RETURNING *
   * Returns null when the intent is not found, not accepted, or assigned to a different solver.
   */
  fillIfAccepted(id: string, solver: string, patch: Omit<Partial<Intent>, "state" | "solver">): Intent | null {
    const existing = this.intents.get(id);
    if (!existing || existing.state !== "accepted" || existing.solver !== solver) return null;

    const updated: Intent = { ...existing, ...patch, state: "filled" };
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
