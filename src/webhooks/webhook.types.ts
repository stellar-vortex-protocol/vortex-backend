/**
 * Webhook subsystem types (issue #432).
 */

/**
 * Every event a subscription can receive. Names are stable — integrators
 * switch on them — so add, never rename.
 *
 * Intent events mirror the WebSocket feed one-to-one (`intent_filled` →
 * `intent.filled`); solver events are emitted by `SolversService` and by
 * slashing.
 */
export const WEBHOOK_EVENT_TYPES = [
  "intent.created",
  "intent.accepted",
  "intent.filled",
  "intent.partially_filled",
  "intent.cancelled",
  "intent.expired",
  "intent.slashed",
  "intent.tranche_reserved",
  "intent.tranche_slashed",
  "intent.destination_invalid",
  "solver.registered",
  "solver.deregistered",
  "solver.deactivated",
  "solver.reactivated",
  "solver.slashed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Subscribe to every event type, including ones added later. */
export const WEBHOOK_ALL_EVENTS = "*";

/** Sent by `POST /webhooks/:id/test`; not subscribable. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

/** WebSocket broadcast type → webhook event type. */
export const GATEWAY_EVENT_MAP: Readonly<Record<string, WebhookEventType>> = {
  intent_created: "intent.created",
  intent_accepted: "intent.accepted",
  intent_filled: "intent.filled",
  intent_partially_filled: "intent.partially_filled",
  intent_cancelled: "intent.cancelled",
  intent_expired: "intent.expired",
  intent_slashed: "intent.slashed",
  intent_tranche_reserved: "intent.tranche_reserved",
  intent_tranche_slashed: "intent.tranche_slashed",
  intent_destination_invalid: "intent.destination_invalid",
};

export type WebhookSubscriptionStatus = "active" | "disabled";

/** A registered endpoint. `secretCiphertext` is the AES-GCM-sealed signing secret. */
export interface WebhookSubscription {
  id: string;
  /** Tenant: the owning API key's `owner` label, so key rotation keeps access. */
  owner: string;
  url: string;
  /** Event types, or `["*"]`. */
  events: string[];
  description?: string;
  secretCiphertext: string;
  /** Last four characters of the secret, for display. */
  secretHint: string;
  status: WebhookSubscriptionStatus;
  disabledReason?: string;
  disabledAt?: string;
  /** Failed deliveries in a row (after all retries). Reset on success. */
  consecutiveFailures: number;
  /** Next per-subscription sequence number to assign. */
  nextSequence: number;
  createdAt: string;
  updatedAt: string;
}

export type WebhookDeliveryStatus = "pending" | "retrying" | "succeeded" | "failed";

/** One HTTP attempt of a delivery. */
export interface WebhookAttempt {
  attempt: number;
  at: string;
  durationMs: number;
  statusCode?: number;
  /** Network / SSRF / timeout error, or "HTTP <status>". */
  error?: string;
  /** First bytes of the response body, for debugging. */
  responseSnippet?: string;
}

/** One event addressed to one subscription. */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  /** Per-subscription sequence number (best-effort ordering). */
  sequence: number;
  /** The exact JSON body that is signed and sent. */
  payload: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  attemptLog: WebhookAttempt[];
  lastStatusCode?: number;
  lastError?: string;
  nextAttemptAt?: string;
  /** Delivery this one replays, if any. */
  replayOf?: string;
  createdAt: string;
  completedAt?: string;
}

/** The JSON envelope every delivery carries. */
export interface WebhookEnvelope {
  /** Event id — identical across retries and replays; use it to dedupe. */
  id: string;
  type: string;
  createdAt: string;
  /** Per-subscription sequence number; gaps mean a delivery is still in flight or failed. */
  sequence: number;
  data: Record<string, unknown>;
}

/** Public view of a subscription — never includes the secret. */
export type WebhookSubscriptionView = Omit<WebhookSubscription, "secretCiphertext" | "nextSequence">;

export function toSubscriptionView(sub: WebhookSubscription): WebhookSubscriptionView {
  const { secretCiphertext: _secret, nextSequence: _seq, ...view } = sub;
  return view;
}

/** Does `sub` want `eventType`? */
export function subscribes(sub: Pick<WebhookSubscription, "events" | "status">, eventType: string): boolean {
  return sub.status === "active" && (sub.events.includes(WEBHOOK_ALL_EVENTS) || sub.events.includes(eventType));
}
