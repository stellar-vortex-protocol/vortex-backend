/** An event as broadcast to WS clients: `seq` is globally ordered across replicas. */
export interface SequencedEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/** An event before the backplane assigns its sequence number. */
export type UnsequencedEvent = { type: string; [key: string]: unknown };

/** Receives every event exactly once per replica, in ascending `seq` order. */
export type BackplaneHandler = (event: SequencedEvent) => void | Promise<void>;

export interface BackplaneHealth {
  mode: "memory" | "redis";
  /** "down" when this replica cannot receive events from the backplane. */
  status: "ok" | "degraded" | "down";
  /** Highest sequence number delivered to this replica. */
  lastSeq: number;
  /** Events accepted by publish() but not yet sequenced by Redis. */
  pendingPublishes: number;
  lastError?: string;
}

/** Optional metrics sink so the backplane stays free of Nest dependencies. */
export interface BackplaneMetrics {
  observePublish(seconds: number): void;
  incDropped(reason: "queue_full" | "closed" | "malformed"): void;
  setConnected(connected: boolean): void;
}

/**
 * Fan-out + sequencing for WS broadcasts (issue #454).
 *
 * `publish()` never blocks the caller on the network; every replica —
 * including the publisher — receives the event through the handler passed to
 * `start()`, so all replicas deliver the same events with the same sequence
 * numbers in the same order.
 */
export interface Backplane {
  readonly mode: "memory" | "redis";
  start(handler: BackplaneHandler): Promise<void>;
  /**
   * Hands an event to the backplane. Resolves once this replica has delivered
   * it (memory mode) or once it has been queued for sequencing (redis mode).
   */
  publish(event: UnsequencedEvent): Promise<void>;
  health(): BackplaneHealth;
  close(): Promise<void>;
}

/** Injection token for the active {@link Backplane}. */
export const WS_BACKPLANE = Symbol("WS_BACKPLANE");
