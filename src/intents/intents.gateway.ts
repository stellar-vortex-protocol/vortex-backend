import { Inject, OnModuleDestroy, Optional } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { SolversService } from "../solvers/solvers.service";
import { MetricsService } from "../metrics/metrics.service";
import { logger } from "../common/logger";
import { SUPPORTED_CHAINS, SupportedChain } from "./intents.types";
import { verifyStellarSignature, buildWsAuthMessage } from "../common/stellar-signature";
import { buildMatchPredicate, IntentCapabilityIndex, SolverMatchPredicate } from "./solver-intent-matcher";
import { IntentFeedService } from "./feed/intent-feed.service";
import type { BackplaneHealth } from "./backplane/backplane.types";
import type { ReplayStore } from "./backplane/replay-store";
import { REPLAY_STORE } from "./backplane/replay-store.token";
import {
  negotiateProtocol,
  resolveProtocol,
  WS_CLOSE_REASON_UNSUPPORTED,
  WS_CLOSE_UNSUPPORTED_PROTOCOL,
} from "./ws-protocol";
import {
  WS_MAX_FILTER_CHAINS,
  WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "../config/limits.config";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How many sequenced events to keep in the replay buffer.
 *
 * At typical broadcast volume (a few dozen events/minute in production),
 * 500 events covers many minutes of missed events — more than enough to
 * bridge a transient network blip or container restart without forcing a
 * full snapshot re-fetch. Increasing this beyond ~1 000 starts to add
 * non-trivial heap pressure for large event payloads; the current bound
 * is a deliberate memory vs. reconnect-gap tradeoff.
 */
const REPLAY_BUFFER_SIZE = 500;

export interface SequencedEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Per-subscriber filter (issue #436).
 *
 * `chains`   — explicit chain subscription set (`null` = unfiltered full feed).
 * `solver`   — capability predicate compiled from the authenticated solver's
 *              SolverRecord.  Non-null only for connections that have completed
 *              the `auth` handshake.
 * `wantAll`  — when `true` (sent via `{ type: "subscribe", all: true }`), the
 *              solver opts out of capability filtering and receives the full
 *              feed regardless of its chain/token support — useful for
 *              analytics consumers.
 */
interface SubscriberFilter {
  chains: Set<SupportedChain> | null;
  /** Compiled solver capability predicate (null = not authenticated). */
  solver: SolverMatchPredicate | null;
  /** Opt-out flag: receives all events even after authentication. */
  wantAll: boolean;
  /** Number of `subscribe` messages this connection has sent. */
  subscriptionCount: number;
}

/**
 * Fixed-size ring buffer that retains the last `capacity` events so
 * reconnecting clients can request a replay from a known sequence number.
 */
export class EventRingBuffer {
  private readonly buf: SequencedEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = REPLAY_BUFFER_SIZE) {
    this.capacity = capacity;
  }

  push(event: SequencedEvent): void {
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
    }
    this.buf.push(event);
  }

  /**
   * Return all buffered events whose seq is strictly greater than `fromSeq`.
   * Returns an empty array when `fromSeq` is older than the earliest buffered
   * event (the caller should request a fresh snapshot instead).
   */
  since(fromSeq: number): SequencedEvent[] {
    return this.buf.filter((e) => e.seq > fromSeq);
  }

  /** Lowest seq still in the buffer, or -1 when empty. */
  oldestSeq(): number {
    return this.buf.length === 0 ? -1 : this.buf[0].seq;
  }

  /** Highest seq in the buffer, or 0 when empty. */
  latestSeq(): number {
    return this.buf.length === 0 ? 0 : this.buf[this.buf.length - 1].seq;
  }

  size(): number {
    return this.buf.length;
  }
}

/**
 * Authentication / access-control decision (issue #49, updated #436)
 * ─────────────────────────────────────────────────────────────────────
 * The intent feed is intentionally PUBLIC and READ-ONLY for all clients.
 *
 * Solver bots that authenticate via `{ type: "auth", ... }` receive an
 * *auto-scoped* feed: only intents matching their supported chains / tokens
 * and with a non-zero bond requirement are delivered.  This reduces noise and
 * bandwidth as the solver set grows (O(solvers × intents) → O(solvers × matching-intents)).
 *
 * Opt-out: `{ type: "subscribe", all: true }` returns the full unfiltered feed
 * regardless of authentication — designed for analytics / monitoring consumers.
 *
 * Solver bots submit intents and accept/fill them through the authenticated
 * REST API. The WS gateway never accepts writes.
 */
@WebSocketGateway({
  path: "/ws",
  /**
   * Protocol negotiation (issue #456).
   *
   * handleProtocols is called by the ws library during the HTTP upgrade
   * handshake.  We always return a string (never false) so the upgrade
   * succeeds and handleConnection can close with code 1002 for unknown
   * versions — giving the client a descriptive WS reason string.
   *
   * - vortex.v1 offered   → echo "vortex.v1"
   * - no protocol offered → echo "" (resolveProtocol treats "" as vortex.v1)
   * - unknown protocol    → echo the first offered token; handleConnection
   *                         then closes with 1002
   */
  handleProtocols: negotiateProtocol,
})
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  /**
   * Map from WebSocket client to its per-connection subscription filter.
   */
  private readonly subscribers = new Map<WebSocket, SubscriberFilter>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly authenticatedSolver = new WeakMap<WebSocket, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private heartbeatTimer: any;
  private nextSeq = 1;
  /** True once graceful connection draining has begun (issue #511). */
  private draining = false;
  private readonly backplane: null | {
    publish: (event: Record<string, unknown>) => void;
    subscribe: (handler: (event: Record<string, unknown>) => void) => void;
  } = null;

  /** Ring buffer storing the last REPLAY_BUFFER_SIZE broadcast events. */
  private readonly ringBuffer = new EventRingBuffer(REPLAY_BUFFER_SIZE);

  /**
   * Sequenced replay store (issue #457).
   *
   * Provided by the IntentsModule via the REPLAY_STORE token (memory or
   * Redis, selected by WS_REPLAY_STORE).  When absent — direct unit-harness
   * construction — replay falls back to the in-process ring buffer above,
   * which the broadcast path always keeps populated as well.
   */
  private readonly replayStore: ReplayStore | null;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentIndex: IntentCapabilityIndex,
    @Optional() private readonly metricsService?: MetricsService,
    /**
     * Sequenced replay store (issue #457) — 5th positional parameter so the
     * backplane test harnesses can inject a MemoryReplayStore directly.
     */
    @Optional() @Inject(REPLAY_STORE) replayStoreParam?: ReplayStore | null,
    /**
     * SSE intent feed (issues #454, #492). Injected `@Optional()` so graphs
     * that do not mount the feed — and the unit harnesses that construct this
     * gateway directly — still run; it only supplies backplane health detail.
     */
    @Optional() private readonly feed?: IntentFeedService,
  ) {
    this.replayStore = replayStoreParam ?? null;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.backplane = this.createBackplane();
    if (this.backplane) {
      this.backplane.subscribe((event) => {
        const type = typeof event.type === "string" ? event.type : "";
        if (!type) return;
        this.dispatchRemoteEvent(event as Record<string, unknown>);
      });
    }
    logger.info("ws heartbeat started");
  }

  private createBackplane(): null | {
    publish: (event: Record<string, unknown>) => void;
    subscribe: (handler: (event: Record<string, unknown>) => void) => void;
  } {
    const mode = (process.env.WS_BACKPLANE ?? "memory").toLowerCase();
    if (mode !== "redis") return null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const redis = require("redis");
      if (!redis?.createClient) {
        logger.warn("WS_BACKPLANE=redis but the redis package is not available; falling back to memory");
        return null;
      }

      const client = redis.createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
      const channel = "vortex:intents:ws";
      const pub = client;
      const sub = client.duplicate();

      void sub.connect();
      void sub.subscribe(channel, (message: string) => {
        try {
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event && typeof event === "object") {
            this.dispatchRemoteEvent(event);
          }
        } catch {
          // Ignore malformed backplane payloads.
        }
      });

      return {
        publish: (event: Record<string, unknown>) => {
          void pub.publish(channel, JSON.stringify(event));
        },
        subscribe: (handler: (event: Record<string, unknown>) => void) => {
          void sub.subscribe(channel, (message: string) => {
            try {
              const event = JSON.parse(message) as Record<string, unknown>;
              handler(event);
            } catch {
              // Ignore malformed backplane payloads.
            }
          });
        },
      };
    } catch {
      logger.warn("WS_BACKPLANE=redis but the redis package is not available; falling back to memory");
      return null;
    }
  }

  private static isSupportedChain(value: unknown): value is SupportedChain {
    return typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value);
  }

  private dispatchRemoteEvent(event: Record<string, unknown>) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!type || type === "connected" || type === "snapshot" || type === "subscribed") return;

    const payload = JSON.stringify(event);
    const chain = this.getEventChainSync(event as { type: string; [key: string]: unknown });
    this.deliverToMatchingSubscribers(payload, chain, event as { type: string; [key: string]: unknown });
  }

  /**
   * Synchronous chain resolution for simple cases (used by dispatchRemoteEvent).
   * Reads srcChain directly from the event or its inlined intent object.
   */
  private getEventChainSync(event: { type: string; [key: string]: unknown }): SupportedChain | null {
    const intent = (event as { intent?: { srcChain?: unknown } }).intent;
    if (intent && typeof intent.srcChain === "string" && IntentsGateway.isSupportedChain(intent.srcChain)) {
      return intent.srcChain;
    }

    const srcChain = (event as { srcChain?: unknown }).srcChain;
    if (typeof srcChain === "string" && IntentsGateway.isSupportedChain(srcChain)) {
      return srcChain;
    }

    return null;
  }

  /**
   * Deliver a pre-serialised event payload to every matching subscriber.
   *
   * Delivery rules (evaluated in order):
   * 1. Client is not OPEN → skip.
   * 2. Client set wantAll=true → always deliver.
   * 3. Client has a solver capability predicate:
   *    a. Event carries an inlined intent → apply predicate to that intent.
   *    b. Event is a state-transition (only intentId available) → deliver
   *       (we cannot efficiently look up the intent here; the solver would
   *       already have received the intent_created event through the filter).
   * 4. Client has a plain chain filter (`chains != null`) → apply chain match.
   * 5. No filter → full unfiltered feed (backward-compatible default).
   */
  private deliverToMatchingSubscribers(
    payload: string,
    chain: SupportedChain | null,
    event: { type: string; [key: string]: unknown },
  ) {
    for (const [client, filter] of this.subscribers) {
      if (client.readyState !== WebSocket.OPEN) continue;

      // Opt-out: solver requested full feed.
      if (filter.wantAll) {
        client.send(payload);
        continue;
      }

      // Authenticated solver — apply capability predicate.
      if (filter.solver !== null) {
        const solverPredicate = filter.solver;
        const inlinedIntent = (event as { intent?: unknown }).intent;

        // intent_created carries a full intent object we can test directly.
        if (event.type === "intent_created" && inlinedIntent && typeof inlinedIntent === "object") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const matches = solverPredicate.matches(inlinedIntent as any);
          if (matches) {
            client.send(payload);
            try { this.metricsService?.incWsDelivered(solverPredicate.solverAddress); } catch { /* noop */ }
          } else {
            try { this.metricsService?.incWsFiltered(solverPredicate.solverAddress); } catch { /* noop */ }
          }
          continue;
        }

        // State-transition events: the solver already filtered on intent_created,
        // so we pass them through to keep the feed self-consistent.
        client.send(payload);
        try { this.metricsService?.incWsDelivered(solverPredicate.solverAddress); } catch { /* noop */ }
        continue;
      }

      // No filter set → full unfiltered feed (backward-compatible default).
      if (filter.chains === null) {
        client.send(payload);
        continue;
      }

      // Chain couldn't be resolved → deliver to everyone (safe default).
      if (chain === null) {
        client.send(payload);
        continue;
      }

      // Only send if the event's chain is in this subscriber's filter.
      if (filter.chains.has(chain)) {
        client.send(payload);
      }
    }
  }

  handleConnection(client: WebSocket) {
    // Graceful shutdown: refuse new clients once draining has begun (issue #511).
    if (this.draining) {
      client.close(1001, "Server draining");
      this.metricsService?.wsConnectionsRejected.inc({ reason: "draining" });
      return;
    }

    // Subprotocol negotiation (issue #456): resolveProtocol treats "" as the
    // backward-compatible default vortex.v1; any other non-empty string that
    // is not vortex.v1 was echoed back by negotiateProtocol and is rejected
    // here with a descriptive close reason.
    const protocolResult = resolveProtocol(
      (client as unknown as { protocol?: string }).protocol ?? "",
    );
    if (!protocolResult.accepted) {
      logger.warn(
        `ws rejected unknown protocol="${(client as unknown as { protocol?: string }).protocol}" — closing 1002`,
      );
      client.close(WS_CLOSE_UNSUPPORTED_PROTOCOL, WS_CLOSE_REASON_UNSUPPORTED);
      return;
    }
    const negotiatedVersion = protocolResult.version;

    this.subscribers.set(client, {
      chains: null,
      solver: null,
      wantAll: false,
      subscriptionCount: 0,
    });
    this.alive.set(client, true);
    this.metricsService?.incWsConnection();

    client.on("message", (raw) => {
      void this.handleMessage(client, raw);
    });

    client.on("pong", () => {
      this.alive.set(client, true);
    });

    client.on("error", () => {
      this.removeSubscriber(client);
      logger.debug(
        `ws client error/drop — active subscribers: ${this.subscribers.size}`,
      );
    });

    const currentSeq = this.nextSeq - 1;

    client.send(
      JSON.stringify({
        type: "connected",
        message: "Vortex intent stream",
        version: negotiatedVersion,
        seq: currentSeq,
      }),
    );

    // Send the initial snapshot asynchronously — the client receives it
    // immediately after the "connected" message.
    Promise.resolve(this.intentsService.getByState("open"))
      .then((open) => {
        client.send(JSON.stringify({ type: "snapshot", intents: open.slice(0, 20), seq: currentSeq }));
      })
      .catch(() => {
        /* snapshot failure is non-fatal — client can re-fetch via REST */
      });

    logger.info(`ws client connected (subscribers=${this.subscribers.size})`);
  }

  handleDisconnect(client: WebSocket) {
    this.removeSubscriber(client);
    logger.info(`ws client disconnected (subscribers=${this.subscribers.size})`);
  }

  /**
   * Drop a client from the subscriber set and keep the connection gauge honest.
   *
   * Every path that removes a client goes through here — explicit disconnect,
   * a transport-level `error`, and the heartbeat terminator — because they are
   * mutually exclusive in practice but not in the platform: a socket that
   * errors frequently never reaches `handleDisconnect`, and one that dies
   * silently is only reaped by the heartbeat. Removing a client from two
   * places with a bare `subscribers.delete` would leak
   * `vortex_ws_connections_active` upwards until the process restarts, and a
   * gauge that only ever climbs turns the WS panels into decoration.
   *
   * The gauge is decremented only when this call actually removed something, so
   * a duplicate disconnect cannot drive it negative.
   */
  private removeSubscriber(client: WebSocket): void {
    const removed = this.subscribers.delete(client);
    this.authenticatedSolver.delete(client);
    this.alive.delete(client);
    if (removed) this.metricsService?.decWsConnection();
  }

  /**
   * Handle a single incoming WebSocket message from a client.
   *
   * Supported message types:
   * - `{ type: "subscribe", chains?: string[], all?: boolean }` — set a
   *   per-connection filter or opt out of capability filtering with `all: true`.
   * - `{ type: "replay", fromSeq: number }` — replay buffered events.
   * - `{ type: "auth", solver, timestamp, signature }` — authenticate as a
   *   registered solver; installs a capability predicate and sends an
   *   auto-scoped snapshot of currently-eligible open intents.
   *
   * Unknown types and malformed messages are silently ignored.
   */
  private async handleMessage(client: WebSocket, raw: import("ws").RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;

    const msg = parsed as Record<string, unknown>;

    switch (msg.type) {
      case "subscribe":
        this.handleSubscribe(client, msg);
        break;
      case "replay":
        await this.handleReplay(client, msg);
        break;
      case "auth":
        await this.handleAuth(client, msg);
        break;
      default:
        break;
    }
  }

  /**
   * Process a `{ type: "subscribe", chains?: string[], all?: boolean }` message.
   *
   * When `all: true` is present, the connection opts out of capability filtering
   * and receives the complete unfiltered feed regardless of solver auth status.
   *
   * When `chains` is present, a per-connection chain filter is installed (this
   * clears any existing solver capability predicate on the connection).
   * Validates each chain value against `SUPPORTED_CHAINS` and stores only
   * the valid subset. A subscribe message with no valid chains is treated as
   * "subscribe to nothing" (the client will receive only chainless events).
   * An entirely missing or non-array `chains` field is rejected silently
   * without updating the existing filter.
   *
   * Issue #476: enforces two per-connection limits:
   * 1. The `chains` array may contain at most `WS_MAX_FILTER_CHAINS` values.
   * 2. A connection may send at most `WS_MAX_SUBSCRIPTIONS_PER_CONNECTION`
   *    subscribe messages in its lifetime.  Excess subscribe attempts are
   *    rejected with a `subscribe_rejected` error frame.
   */
  private handleSubscribe(client: WebSocket, msg: Record<string, unknown>): void {
    // all=true: opt out of capability filtering.
    if (msg.all === true) {
      const existing = this.subscribers.get(client) ?? {
        chains: null,
        solver: null,
        wantAll: false,
        subscriptionCount: 0,
      };
      this.subscribers.set(client, { ...existing, wantAll: true });
      logger.debug("ws client opted out of capability filtering (all=true)");
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "subscribed", filter: { all: true } }));
      }
      return;
    }

    if (!Array.isArray(msg.chains)) {
      logger.debug("ws subscribe ignored: chains field missing or not an array");
      return;
    }

    const filter = this.subscribers.get(client);
    if (!filter) return;

    // ── Limit 1: max subscriptions per connection (issue #476) ───────────────
    const maxSubs = parseInt(
      process.env.WS_MAX_SUBSCRIPTIONS ?? String(WS_MAX_SUBSCRIPTIONS_PER_CONNECTION),
      10,
    );
    if (filter.subscriptionCount >= maxSubs) {
      logger.warn(
        `ws subscribe_rejected: connection has reached the max subscription limit (${maxSubs})`,
      );
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "subscribe_rejected",
            reason: `Maximum subscription limit of ${maxSubs} reached for this connection`,
          }),
        );
      }
      return;
    }

    // ── Limit 2: max chain-filter values per subscribe message (issue #476) ──
    const maxChains = parseInt(
      process.env.WS_MAX_FILTER_CHAINS ?? String(WS_MAX_FILTER_CHAINS),
      10,
    );
    const rawChains = msg.chains as unknown[];
    if (rawChains.length > maxChains) {
      logger.warn(
        `ws subscribe_rejected: chains array length ${rawChains.length} exceeds max ${maxChains}`,
      );
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "subscribe_rejected",
            reason: `chains array may contain at most ${maxChains} values`,
          }),
        );
      }
      return;
    }

    const validChains = rawChains.filter(
      (c): c is SupportedChain =>
        typeof c === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(c),
    );

    filter.chains = new Set(validChains);
    filter.subscriptionCount += 1;

    logger.debug(`ws client subscribed to chains: ${validChains.join(", ") || "(none)"}`);

    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "subscribed",
          filter: { chains: validChains },
        }),
      );
    }
  }

  /**
   * Process a `{ type: "replay", fromSeq: number }` message.
   *
   * Events are read from the injected replay store when one is wired
   * (issue #457 — memory or Redis, survives restarts and spans replicas),
   * otherwise from the in-process ring buffer.  Before the events are sent,
   * the requesting connection's subscription filter (chains or solver
   * capability predicate) is applied so replay honours the same
   * server-side scoping as live delivery.
   */
  private async handleReplay(client: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const fromSeq = typeof msg.fromSeq === "number" ? msg.fromSeq : null;
    if (fromSeq === null || !Number.isInteger(fromSeq) || fromSeq < 0) {
      logger.debug("ws replay ignored: fromSeq missing or invalid");
      return;
    }

    if (client.readyState !== WebSocket.OPEN) return;

    let events: SequencedEvent[];
    if (this.replayStore) {
      const result = await this.replayStore.since(fromSeq);
      if (result.tooOld) {
        const oldest = await this.replayStore.oldestSeq();
        client.send(JSON.stringify({ type: "replay_too_old", fromSeq, oldestAvailableSeq: oldest }));
        logger.debug(`ws replay_too_old: fromSeq=${fromSeq} oldestAvailable=${oldest}`);
        return;
      }
      events = result.events;
    } else {
      const oldest = this.ringBuffer.oldestSeq();

      if (oldest !== -1 && fromSeq < oldest - 1) {
        client.send(
          JSON.stringify({
            type: "replay_too_old",
            fromSeq,
            oldestAvailableSeq: oldest,
          }),
        );
        logger.debug(`ws replay_too_old: fromSeq=${fromSeq} oldestAvailable=${oldest}`);
        return;
      }

      events = this.ringBuffer.since(fromSeq);
    }

    client.send(
      JSON.stringify({
        type: "replay_start",
        fromSeq,
        count: events.length,
      }),
    );

    const filter = this.subscribers.get(client);
    for (const event of events) {
      if (client.readyState !== WebSocket.OPEN) break;
      // Apply server-side filter (same logic as deliverToMatchingSubscribers
      // but for this one client).
      if (filter) {
        if (!filter.wantAll) {
          if (filter.solver !== null) {
            const solverPredicate = filter.solver;
            const inlinedIntent = (event as { intent?: unknown }).intent;
            if (event.type === "intent_created" && inlinedIntent && typeof inlinedIntent === "object") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (!solverPredicate.matches(inlinedIntent as any)) continue;
            }
            // state-transition events pass through
          } else if (filter.chains !== null) {
            const chain = this.getEventChainSync(event);
            if (chain !== null && !filter.chains.has(chain)) continue;
          }
        }
      }
      client.send(JSON.stringify(event));
    }

    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "replay_end",
          count: events.length,
        }),
      );
    }

    logger.debug(`ws replay complete: fromSeq=${fromSeq} count=${events.length}`);
  }

  /**
   * Authenticate a solver connection and install a capability predicate.
   *
   * On success:
   * 1. Compiles a per-solver match predicate from the solver's SolverRecord.
   * 2. Installs it on the subscriber filter so future broadcasts are scoped.
   * 3. Sends an `auth_ok` frame.
   * 4. Immediately sends a scoped `eligible_snapshot` with currently-eligible
   *    open intents from the in-memory index — so the solver doesn't need to
   *    separately call GET /solvers/:address/eligible-intents after auth.
   *
   * Capability updates (e.g. bond changes ingested via event-ingestion) call
   * `updateSolverPredicate()` directly — no reconnect required.
   */
  private async handleAuth(client: WebSocket, payload: Record<string, unknown>) {
    const solver = typeof payload.solver === "string" ? payload.solver : "";
    const timestamp = payload.timestamp;
    const signature = typeof payload.signature === "string" ? payload.signature : "";

    if (!solver || !signature || typeof timestamp !== "number") {
      client.send(JSON.stringify({ type: "auth_error", reason: "auth payload requires solver, timestamp, and signature" }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - timestamp);
    if (skew > 300) {
      client.send(JSON.stringify({ type: "auth_error", reason: "stale or future auth timestamp" }));
      return;
    }

    const solverRecord = await this.solversService.get(solver);
    if (!solverRecord || !solverRecord.isActive) {
      client.send(JSON.stringify({ type: "auth_error", reason: "solver not registered or inactive" }));
      return;
    }

    try {
      verifyStellarSignature(solver, buildWsAuthMessage(solver, timestamp), signature);
    } catch {
      client.send(JSON.stringify({ type: "auth_error", reason: "invalid solver signature" }));
      return;
    }

    // Build capability predicate and store it on the connection.
    const predicate = buildMatchPredicate(solverRecord);
    this.authenticatedSolver.set(client, solver);
    const authFilter = this.subscribers.get(client);
    this.subscribers.set(client, {
      chains: authFilter?.chains ?? null,
      solver: predicate,
      wantAll: authFilter?.wantAll ?? false,
      subscriptionCount: authFilter?.subscriptionCount ?? 0,
    });

    client.send(JSON.stringify({ type: "auth_ok" }));

    // Send scoped snapshot of currently-eligible intents (issue #436).
    try {
      const eligible = this.intentIndex.getEligibleFor(solverRecord);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "eligible_snapshot",
          intents: eligible,
          count: eligible.length,
        }));
      }
    } catch {
      // Non-fatal — solver can fall back to GET /solvers/:address/eligible-intents.
    }

    logger.info(`ws solver auth ok: address=${solver} chains=${solverRecord.supportedChains.join(",")} tokens=${solverRecord.supportedTokens.join(",")}`);
  }

  /**
   * Update the capability predicate for all live connections authenticated as
   * the given solver address.
   *
   * Called by EventIngestionService when a BondDeposited / BondWithdrawn /
   * SolverRegistered event updates a solver's capabilities — no reconnect needed.
   */
  async updateSolverPredicate(solverAddress: string): Promise<void> {
    const solverRecord = await this.solversService.get(solverAddress);
    if (!solverRecord) return;

    const predicate = buildMatchPredicate(solverRecord);
    for (const [client, filter] of this.subscribers) {
      if (this.authenticatedSolver.get(client) === solverAddress && filter.solver !== null) {
        this.subscribers.set(client, { ...filter, solver: predicate });
      }
    }

    logger.debug(`ws solver predicate updated for ${solverAddress}`);
  }

  /**
   * Resolve the source chain for an event payload.
   */
  private async getEventChain(
    event: { type: string; [key: string]: unknown },
  ): Promise<SupportedChain | null> {
    if (event.type === "intent_created") {
      const intent = event.intent as { srcChain?: string } | undefined;
      const chain = intent?.srcChain;
      if (chain && (SUPPORTED_CHAINS as readonly string[]).includes(chain)) {
        return chain as SupportedChain;
      }
      return null;
    }

    const lookupTypes = new Set([
      "intent_accepted",
      "intent_filled",
      "intent_cancelled",
      "intent_expired",
      "intent_slashed",
    ]);

    if (lookupTypes.has(event.type)) {
      const intentId = typeof event.intentId === "string" ? event.intentId : null;
      if (!intentId) return null;

      try {
        const intent = await this.intentsService.get(intentId);
        if (intent && (SUPPORTED_CHAINS as readonly string[]).includes(intent.srcChain)) {
          return intent.srcChain as SupportedChain;
        }
      } catch {
        // Lookup failure is non-fatal — deliver to all subscribers.
      }
      return null;
    }

    return null;
  }

  /**
   * Assign a monotonically increasing sequence number, push the event into
   * the ring buffer, then deliver it to every subscriber whose filter matches.
   *
   * For authenticated solvers without `all=true`, only intents matching their
   * capability predicate are delivered.  State-transition events (no inlined
   * intent) are always delivered to authenticated subscribers.
   *
   * Side-effects:
   * - Updates the intent index for `intent_created` (add) and terminal-state
   *   events (remove), keeping the capability index fresh without a rebuild.
   */
  async broadcast(event: { type: string; [key: string]: unknown }): Promise<void> {
    const enqueuedAt = Date.now();
    const seq = this.nextSeq++;
    const sequencedEvent: SequencedEvent = { ...event, seq };

    // Update the capability index before delivery so a racing replay or
    // eligible-intents call sees fresh state.
    this.updateIndexForEvent(event);

    // Push into replay buffer before sending.
    this.ringBuffer.push(sequencedEvent);
    // Mirror into the injected replay store (issue #457) so reconnecting
    // clients can replay across restarts/replicas.
    if (this.replayStore) {
      try {
        await this.replayStore.append(sequencedEvent);
      } catch (err) {
        logger.warn(`replay store append failed: ${String(err)}`);
      }
    }

    logger.debug(`ws broadcast type=${event.type} seq=${seq} subscribers=${this.subscribers.size}`);

    if (this.backplane) {
      this.backplane.publish(sequencedEvent as Record<string, unknown>);
    }

    // Resolve the chain once — shared across all subscriber checks.
    const eventChain = await this.getEventChain(event);

    const payload = JSON.stringify(sequencedEvent);
    this.deliverToMatchingSubscribers(payload, eventChain, event);

    try {
      this.metricsService?.observeWsDelivery((Date.now() - enqueuedAt) / 1000);
    } catch {
      // Metrics must never break broadcasts.
    }
  }

  /** Keep the IntentCapabilityIndex in sync with broadcast events. */
  private updateIndexForEvent(event: { type: string; [key: string]: unknown }): void {
    try {
      if (event.type === "intent_created") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const intent = (event as any).intent;
        if (intent) this.intentIndex.addIntent(intent);
      } else if (
        event.type === "intent_accepted" ||
        event.type === "intent_filled" ||
        event.type === "intent_cancelled" ||
        event.type === "intent_expired" ||
        event.type === "intent_slashed"
      ) {
        const intentId = typeof event.intentId === "string" ? event.intentId : null;
        if (intentId) this.intentIndex.removeIntent(intentId);
      }
    } catch {
      // Index update is best-effort — never break broadcasts.
    }
  }

  getAliveCount(): number {
    let count = 0;
    for (const client of this.subscribers.keys()) {
      if (this.alive.get(client) === true) count++;
    }
    return count;
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Backplane health for /health (issues #454, #492).
   *
   * Delegates to the intent feed when it is wired — the feed owns the real
   * backplane link (and its Redis connection state). Without a feed, fall
   * back to this gateway's own view: a memory backplane is a single replica
   * and is healthy by construction; the gateway's redis mirror reports its
   * sequenced high-water mark.
   */
  backplaneHealth(): BackplaneHealth {
    if (this.feed) return this.feed.backplaneHealth();
    return {
      mode: this.backplane ? "redis" : "memory",
      status: "ok",
      lastSeq: this.nextSeq - 1,
      pendingPublishes: 0,
    };
  }

  /** Returns the current number of active WebSocket subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private heartbeat() {
    for (const [client] of this.subscribers) {
      if (this.alive.get(client) === false) {
        client.terminate();
        this.removeSubscriber(client);
        logger.debug(
          `ws heartbeat terminated dead client (subscribers=${this.subscribers.size})`,
        );
        continue;
      }

      this.alive.set(client, false);
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }

  /**
   * Graceful connection draining (issue #511):
   * 1. Set the draining flag so `handleConnection` refuses new clients
   * 2. Send every connected client a `server_draining` event carrying the
   *    resume sequence so it can reconnect with replay
   * 3. Close connections in batches with jittered delays to avoid a
   *    reconnect stampede against the replacement pod
   *
   * Kubernetes terminationGracePeriodSeconds should be at least
   * WS_DRAIN_TIMEOUT_MS + 5s.
   */
  async startDraining(): Promise<void> {
    if (this.draining) return;

    this.draining = true;
    const drainTimeoutMs = parseInt(process.env.WS_DRAIN_TIMEOUT_MS ?? "25000", 10);
    const currentSeq = this.nextSeq - 1;
    const clientCount = this.subscribers.size;

    logger.warn(`ws draining started: ${clientCount} clients, timeout=${drainTimeoutMs}ms`);

    const drainMessage = JSON.stringify({
      type: "server_draining",
      resumeFrom: currentSeq,
      reconnectAfterMs: Math.floor(1000 + Math.random() * 4000),
      reason: "graceful_shutdown",
    });

    for (const [client] of this.subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(drainMessage);
        } catch {
          /* best effort — the connection is going away anyway */
        }
      }
    }

    if (clientCount === 0) {
      logger.warn("ws draining complete: no clients connected");
      return;
    }

    const batchSize = Math.max(10, Math.ceil(clientCount / 10));
    const clients = Array.from(this.subscribers.keys());
    const batchDelayMs = Math.floor(drainTimeoutMs / Math.ceil(clientCount / batchSize));

    for (let i = 0; i < clients.length; i += batchSize) {
      const batch = clients.slice(i, i + batchSize);
      if (i > 0) await new Promise((r) => setTimeout(r, batchDelayMs));

      for (const client of batch) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, "Server draining");
        }
        this.removeSubscriber(client);
      }

      logger.info(
        `ws drain progress: ${Math.min(i + batchSize, clientCount)}/${clientCount} closed`,
      );
    }

    logger.warn("ws draining complete: all clients closed");
  }

  /** True while the gateway refuses new connections during shutdown (issue #511). */
  isDraining(): boolean {
    return this.draining;
  }

  async onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.startDraining();
  }
}
