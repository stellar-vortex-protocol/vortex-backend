import type { WebhookDelivery, WebhookSubscription } from "./webhook.types";
import { subscribes } from "./webhook.types";

export const WEBHOOKS_REPOSITORY = Symbol("WEBHOOKS_REPOSITORY");

export type SubscriptionPatch = Partial<
  Pick<
    WebhookSubscription,
    "url" | "events" | "description" | "secretCiphertext" | "secretHint" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures"
  >
>;

export type DeliveryPatch = Partial<
  Pick<WebhookDelivery, "status" | "attempts" | "attemptLog" | "lastStatusCode" | "lastError" | "nextAttemptAt" | "completedAt">
>;

export interface DeliveryListQuery {
  status?: WebhookDelivery["status"];
  limit: number;
  /** Return deliveries created strictly before this delivery (newest-first paging). */
  before?: string;
}

/**
 * Storage for webhook subscriptions and their delivery log (issue #432).
 *
 * The delivery row is written before the job is enqueued — it is the
 * outbox record — so a crash between the two leaves a `pending` row that the
 * recovery sweep re-enqueues.
 */
export interface IWebhooksRepository {
  createSubscription(sub: WebhookSubscription): Promise<WebhookSubscription>;
  getSubscription(id: string): Promise<WebhookSubscription | undefined>;
  listSubscriptions(owner: string): Promise<WebhookSubscription[]>;
  /** Active subscriptions that want `eventType`. */
  findSubscribers(eventType: string): Promise<WebhookSubscription[]>;
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<WebhookSubscription | undefined>;
  deleteSubscription(id: string): Promise<boolean>;
  /** Atomically take the next sequence number for a subscription. */
  takeSequence(id: string): Promise<number>;
  /** Atomically bump `consecutiveFailures` and return the new value. */
  incrementFailures(id: string): Promise<number>;

  createDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | undefined>;
  listDeliveries(subscriptionId: string, query: DeliveryListQuery): Promise<WebhookDelivery[]>;
  updateDelivery(id: string, patch: DeliveryPatch): Promise<WebhookDelivery | undefined>;
  /** `pending` / `retrying` deliveries whose next attempt is due before `cutoff`. */
  findStalled(cutoff: string, limit: number): Promise<WebhookDelivery[]>;
}

/** Process-local adapter (`WEBHOOKS_PERSISTENCE=memory`). */
export class InMemoryWebhooksRepository implements IWebhooksRepository {
  private readonly subs = new Map<string, WebhookSubscription>();
  private readonly deliveries = new Map<string, WebhookDelivery>();

  async createSubscription(sub: WebhookSubscription): Promise<WebhookSubscription> {
    this.subs.set(sub.id, { ...sub });
    return { ...sub };
  }

  async getSubscription(id: string): Promise<WebhookSubscription | undefined> {
    const sub = this.subs.get(id);
    return sub ? { ...sub } : undefined;
  }

  async listSubscriptions(owner: string): Promise<WebhookSubscription[]> {
    return [...this.subs.values()]
      .filter((s) => s.owner === owner)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => ({ ...s }));
  }

  async findSubscribers(eventType: string): Promise<WebhookSubscription[]> {
    return [...this.subs.values()].filter((s) => subscribes(s, eventType)).map((s) => ({ ...s }));
  }

  async updateSubscription(id: string, patch: SubscriptionPatch): Promise<WebhookSubscription | undefined> {
    const sub = this.subs.get(id);
    if (!sub) return undefined;
    const updated = { ...sub, ...patch, updatedAt: new Date().toISOString() };
    this.subs.set(id, updated);
    return { ...updated };
  }

  async deleteSubscription(id: string): Promise<boolean> {
    return this.subs.delete(id);
  }

  async takeSequence(id: string): Promise<number> {
    const sub = this.subs.get(id);
    if (!sub) throw new Error(`Unknown subscription ${id}`);
    const seq = sub.nextSequence;
    sub.nextSequence = seq + 1;
    return seq;
  }

  async incrementFailures(id: string): Promise<number> {
    const sub = this.subs.get(id);
    if (!sub) return 0;
    sub.consecutiveFailures += 1;
    return sub.consecutiveFailures;
  }

  async createDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    this.deliveries.set(delivery.id, structuredClone(delivery));
    return structuredClone(delivery);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | undefined> {
    const d = this.deliveries.get(id);
    return d ? structuredClone(d) : undefined;
  }

  async listDeliveries(subscriptionId: string, query: DeliveryListQuery): Promise<WebhookDelivery[]> {
    let rows = [...this.deliveries.values()]
      .filter((d) => d.subscriptionId === subscriptionId && (!query.status || d.status === query.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence);
    if (query.before) {
      const index = rows.findIndex((d) => d.id === query.before);
      rows = index >= 0 ? rows.slice(index + 1) : rows;
    }
    return rows.slice(0, query.limit).map((d) => structuredClone(d));
  }

  async updateDelivery(id: string, patch: DeliveryPatch): Promise<WebhookDelivery | undefined> {
    const d = this.deliveries.get(id);
    if (!d) return undefined;
    const updated = { ...d, ...structuredClone(patch) };
    this.deliveries.set(id, updated);
    return structuredClone(updated);
  }

  async findStalled(cutoff: string, limit: number): Promise<WebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter((d) => (d.status === "pending" || d.status === "retrying") && (d.nextAttemptAt ?? d.createdAt) < cutoff)
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }
}
