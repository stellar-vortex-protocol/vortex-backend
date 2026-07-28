import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentAuditEntry, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

@Injectable()
export class IntentsService {
  private readonly intents = new Map<string, Intent>();

  /**
   * Append-only audit log keyed by intentId.
   * Each entry records a single state transition.
   * Issue #62 – once persistence lands (issue #36) this will be written to an
   * `intent_audit_log` table; for now it survives in-memory for the process lifetime.
   */
  private readonly auditLog = new Map<string, IntentAuditEntry[]>();

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

  // ---------------------------------------------------------------------------
  // Audit trail (issue #62)
  // ---------------------------------------------------------------------------

  /**
   * Append a new audit entry for the given intent.
   * Call this whenever an intent transitions state so the full history is
   * preserved even after the `state` field is overwritten.
   *
   * @param intentId  - ID of the intent being transitioned.
   * @param toState   - The state the intent is moving INTO.
   * @param actor     - Address or identifier of who triggered the change
   *                    ("system" for sweeper-driven expirations).
   * @param reason    - Short human-readable description of why the transition occurred.
   * @param metadata  - Optional bag of extra data (e.g. fill amount, tx hash).
   */
  appendAuditEntry(
    intentId: string,
    toState: IntentState,
    actor: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: IntentAuditEntry = {
      timestamp: new Date().toISOString(),
      toState,
      actor,
      reason,
      ...(metadata ? { metadata } : {}),
    };

    const entries = this.auditLog.get(intentId) ?? [];
    entries.push(entry);
    this.auditLog.set(intentId, entries);
  }

  /**
   * Return the full audit trail for a given intent, oldest-first.
   * Returns an empty array if the intent has no recorded transitions.
   */
  getAuditLog(intentId: string): IntentAuditEntry[] {
    return this.auditLog.get(intentId) ?? [];
  }

  // ---------------------------------------------------------------------------

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
