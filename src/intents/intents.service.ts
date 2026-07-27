import { Inject, Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { INTENTS_REPOSITORY, IIntentsRepository } from "./intents.repository";
import { Intent, IntentState } from "./intents.types";

/**
 * Orchestration layer for intents.
 *
 * Business logic (ID generation, default state, deadline defaulting) lives
 * here.  All persistence is delegated to the injected IIntentsRepository so
 * the storage adapter can be swapped (in-memory → Prisma → on-chain) without
 * touching this service.
 */
@Injectable()
export class IntentsService {
  constructor(
    @Inject(INTENTS_REPOSITORY)
    private readonly repo: IIntentsRepository,
  ) {}

  create(data: Omit<Intent, "intentId" | "createdAt" | "state">): Intent {
    const now = Math.floor(Date.now() / 1000);
    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline: data.deadline ?? now + 1800,
    };
    return this.repo.save(intent);
  }

  get(id: string): Intent | undefined {
    return this.repo.findById(id);
  }

  getAll(): Intent[] {
    return this.repo.findAll();
  }

  getByState(state: IntentState): Intent[] {
    return this.repo.findByState(state);
  }

  getByUser(user: string): Intent[] {
    return this.repo.findByUser(user);
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    return this.repo.update(id, patch);
  }
}
