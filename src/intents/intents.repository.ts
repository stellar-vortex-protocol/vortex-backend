import { Injectable } from "@nestjs/common";
import { Intent, IntentState } from "./intents.types";

export abstract class IntentsRepository {
  abstract save(intent: Intent): Intent | Promise<Intent>;
  abstract findById(id: string): Intent | undefined | Promise<Intent | undefined>;
  abstract findAll(): Intent[] | Promise<Intent[]>;
  abstract findByState(state: IntentState): Intent[] | Promise<Intent[]>;
  abstract findByUser(user: string): Intent[] | Promise<Intent[]>;
  abstract update(id: string, patch: Partial<Intent>): Intent | null | Promise<Intent | null>;
}

@Injectable()
export class InMemoryIntentsRepository implements IntentsRepository {
  private readonly intents = new Map<string, Intent>();

  save(intent: Intent): Intent {
    this.intents.set(intent.intentId, intent);
    return intent;
  }

  findById(id: string): Intent | undefined {
    return this.intents.get(id);
  }

  findAll(): Intent[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  findByState(state: IntentState): Intent[] {
    return this.findAll().filter((i) => i.state === state);
  }

  findByUser(user: string): Intent[] {
    return this.findAll().filter((i) => i.user.toLowerCase() === user.toLowerCase());
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.intents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.intents.set(id, updated);
    return updated;
  }
}

/**
 * Postgres implementation stub for production persistent storage integration.
 */
@Injectable()
export class PostgresIntentsRepository implements IntentsRepository {
  // Database connection / ORM entity manager would be injected here
  save(intent: Intent): Intent {
    throw new Error("Method not implemented. Configure Postgres connection.");
  }

  findById(id: string): Intent | undefined {
    throw new Error("Method not implemented. Configure Postgres connection.");
  }

  findAll(): Intent[] {
    throw new Error("Method not implemented. Configure Postgres connection.");
  }

  findByState(state: IntentState): Intent[] {
    throw new Error("Method not implemented. Configure Postgres connection.");
  }

  findByUser(user: string): Intent[] {
    throw new Error("Method not implemented. Configure Postgres connection.");
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    throw new Error("Method not implemented. Configure Postgres connection.");
  }
}
