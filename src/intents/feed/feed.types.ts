import { IntentState, SupportedChain } from "../intents.types";
import { SolverMatchPredicate } from "../solver-intent-matcher";
import { SequencedEvent } from "../backplane/backplane.types";

/**
 * Transport-agnostic intent feed (issue #433).
 *
 * The feed owns event sequencing (via the backplane), the replay buffer,
 * subscriber filtering, and connection accounting.  Two adapters consume it:
 *   - {@link IntentsGateway} — the WebSocket adapter.
 *   - {@link IntentsSseController} — the Server-Sent Events adapter.
 *
 * Keeping sequencing, replay and filtering in one place means the WS and SSE
 * feeds can never diverge in event order, replay semantics, or filter
 * behaviour.
 */

/**
 * A client connected to the feed, regardless of transport.
 *
 * Adapters implement this interface to bridge the feed service to a specific
 * transport (WebSocket, SSE, …).
 */
export interface FeedClient {
  /** Unique connection id (used for accounting and cleanup). */
  readonly id: string;
  /** Client IP (resolved through the trusted-proxy hops). */
  readonly ip: string;
  /**
   * Deliver a pre-serialized event payload.
   *
   * @param payload The event, JSON-serialised, with its sequence number as the
   *   first key. Adapters that need the sequence separately (SSE uses it for the
   *   `id:` field that powers `Last-Event-ID` resumption) get it from `seq`
   *   rather than re-parsing the payload.
   * @returns `true` if the payload was accepted, `false` when the client's
   *   outbound buffer exceeded the backpressure limit and the adapter should
   *   be disconnected.
   */
  send(payload: string, seq: number): boolean;
  /** Close the connection (idempotent). */
  close(): void;
}

/**
 * Per-client subscription filter (issue #436, extended #433).
 *
 * `chains`   — explicit chain subscription set (`null` = unfiltered full feed).
 * `solver`   — capability predicate compiled from the authenticated solver's
 *              SolverRecord.  Non-null only for connections that have completed
 *              the `auth` handshake.
 * `wantAll`  — when `true`, the client opts out of capability filtering and
 *              receives the full feed regardless of chain/token support.
 * `users`    — optional user-address filter (SSE `user` query param).
 * `states`   — optional intent-state filter (SSE `state` query param).
 */
export interface FeedFilter {
  chains: Set<SupportedChain> | null;
  solver: SolverMatchPredicate | null;
  wantAll: boolean;
  users: Set<string> | null;
  states: Set<IntentState> | null;
  /** Number of `subscribe` messages this connection has sent (WS only). */
  subscriptionCount: number;
}

/** Result of admitting a client to the feed. */
export interface FeedAdmission {
  ok: boolean;
  /** Reason for rejection (`max_connections` or `per_ip`); absent when ok. */
  reason?: "max_connections" | "per_ip";
}

/** Replay outcome for a `Last-Event-ID` / `fromSeq` request. */
export interface FeedReplayResult {
  /** Events newer than the requested sequence. */
  events: SequencedEvent[];
  /** True when the requested sequence is older than the replay buffer. */
  tooOld: boolean;
  /** Oldest sequence still available in the replay buffer (when not tooOld). */
  oldestSeq: number;
}
