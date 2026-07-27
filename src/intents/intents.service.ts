import { Injectable, Inject, Optional } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";
import { IntentsRepository, InMemoryIntentsRepository } from "./intents.repository";

@Injectable()
export class IntentsService {
  private readonly repository: IntentsRepository;

  constructor(@Optional() @Inject(IntentsRepository) repository?: IntentsRepository) {
    this.repository = repository || new InMemoryIntentsRepository();
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
    return this.repository.save(intent) as Intent;
  }

  get(id: string): Intent | undefined {
    return this.repository.findById(id) as Intent | undefined;
  }

  getAll(): Intent[] {
    return this.repository.findAll() as Intent[];
  }

  getByState(state: IntentState): Intent[] {
    return this.repository.findByState(state) as Intent[];
  }

  getByUser(user: string): Intent[] {
    return this.repository.findByUser(user) as Intent[];
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    return this.repository.update(id, patch) as Intent | null;
  }

  private seed() {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.repository.save(intent);
    }
  }
}

