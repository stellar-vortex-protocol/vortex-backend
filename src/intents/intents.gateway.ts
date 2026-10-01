import { Inject, OnModuleDestroy, Optional } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { IntentsService } from "./intents.service";
import { SolversService } from "../solvers/solvers.service";
import { MetricsService } from "../metrics/metrics.service";
import { logger } from "../common/logger";
import { SUPPORTED_CHAINS, SupportedChain } from "./intents.types";
import { verifyStellarSignature, buildWsAuthMessage } from "../common/stellar-signature";
import { buildMatchPredicate, IntentCapabilityIndex, SolverMatchPredicate } from "./solver-intent-matcher";
import {
  REPLAY_STORE,
  type ReplayStore,
  type SequencedEvent,
} from "./backplane/replay-store";
import { MemoryReplayStore } from "./backplane/memory-replay.store";
import {
  negotiateFromRequest,
  selectWsSubprotocol,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_UNSUPPORTED_PROTOCOL,
} from "../ws/ws-protocol";
import { validateClientMessage, validateServerFrame, wsValidationEnabled } from "../ws/ws-schemas";
import {
  WS_MAX_FILTER_CHAINS,
  WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "../config/limits.config";

const HEARTBEAT_INTERVAL_MS = 30_000;

// Re-exported for backwards compatibility — the type now lives next to the
// ReplayStore abstraction (issue #457).
export type { SequencedEvent } from "./backplane/replay-store";

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
 *
 * Protocol versioning (issue #456): the handshake negotiates a
 * `Sec-WebSocket-Protocol` version (see `src/ws/ws-protocol.ts`). Clients that
 * only offer unknown versions are closed with code 1002; a client that offers
 * none is served the documented default, `vortex.v1`.
 */
@WebSocketGateway({ path: "/ws", handleProtocols: selectWsSubprotocol })
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

  private readonly backplane: null | {
    publish: (event: Record<string, unknown>) => void;
    subscribe: (handler: (event: Record<string, unknown>) => void) => void;
  } = null;

  /**
   * Replay log (issue #457): memory by default, Redis Streams when
   * `WS_REPLAY_STORE=redis` — see `./backplane/replay-store.ts`.
   */
  private readonly replayStore: ReplayStore;

  /**
   * Highest sequence number this process has seen (allocated locally, or
   * observed on the backplane / restored from the store after a restart).
   * Mirrored synchronously so `handleConnection` can report it in the
   * `connected` frame without awaiting I/O.
   */
  private seqMirror = 0;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentIndex: IntentCapabilityIndex,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() @Inject(REPLAY_STORE) replayStore?: ReplayStore,
  ) {
    this.replayStore = replayStore ?? new MemoryReplayStore();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.backplane = this.createBackplane();
    if (this.backplane) {
      this.backplane.subscribe((event) => {
        const type = typeof event.type === "string" ? event.type : "";
        if (!type) return;
        this.dispatchRemoteEvent(event as Record<string, unknown>);
      });
    }
    // Restore the sequence position from the durable store (issue #457): after
    // a restart the `connected` frame reports the real end of the log instead
    // of 0, so clients can resume from where the process left off.
    void this.primeSeqMirror();
    logger.info("ws heartbeat started");
  }

  private async primeSeqMirror(): Promise<void> {
    try {
      const latest = await this.replayStore.latestSeq();
      if (latest > this.seqMirror) this.seqMirror = latest;
    } catch (err) {
      logger.warn(`ws replay store unavailable at startup: ${(err as Error).message}`);
    }
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

    // Keep the sequence mirror honest so `connected` reports a useful resume
    // point even for events this replica only fanned out (issue #457).
    const seq = event.seq;
    if (typeof seq === "number" && Number.isFinite(seq) && seq > this.seqMirror) {
      this.seqMirror = seq;
    }

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
   * Decide whether one subscriber should receive one event — the single
   * source of truth for both the live feed and replays (issue #457), so a
   * replayed window can never disagree with what was delivered live.
   *
   * Delivery rules (evaluated in order):
   * 1. Client set wantAll=true → always deliver.
   * 2. Client has a solver capability predicate:
   *    a. Event carries an inlined intent → apply predicate to that intent.
   *    b. Event is a state-transition (only intentId available) → deliver
   *       (we cannot efficiently look up the intent here; the solver would
   *       already have received the intent_created event through the filter).
   * 3. Client has a plain chain filter (`chains != null`) → apply chain match.
   * 4. No filter → full unfiltered feed (backward-compatible default).
   *
   * @param chain - Event chain resolved by the caller (`getEventChain` on the
   *   live path, `getEventChainSync` when replaying); `null` when unknown,
   *   which delivers rather than drops (safe default).
   */
  private matchesFilter(
    filter: SubscriberFilter,
    event: { type: string; [key: string]: unknown },
    chain: SupportedChain | null = this.getEventChainSync(event),
  ): boolean {
    // Opt-out: solver requested full feed.
    if (filter.wantAll) return true;

    // Authenticated solver — apply capability predicate.
    if (filter.solver !== null) {
      const inlinedIntent = (event as { intent?: unknown }).intent;

      // intent_created carries a full intent object we can test directly.
      if (event.type === "intent_created" && inlinedIntent && typeof inlinedIntent === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return filter.solver.matches(inlinedIntent as any);
      }

      // State-transition events: the solver already filtered on intent_created,
      // so we pass them through to keep the feed self-consistent.
      return true;
    }

    // No filter set → full unfiltered feed (backward-compatible default).
    if (filter.chains === null) return true;

    // Chain couldn't be resolved → deliver to everyone (safe default).
    if (chain === null) return true;

    // Only send if the event's chain is in this subscriber's filter.
    return filter.chains.has(chain);
  }

  /**
   * Deliver a pre-serialised event payload to every matching subscriber.
   *
   * The match decision itself lives in {@link matchesFilter}; this loop only
   * serialises sends and the solver delivered/filtered metrics.
   */
  private deliverToMatchingSubscribers(
    payload: string,
    chain: SupportedChain | null,
    event: { type: string; [key: string]: unknown },
  ) {
    for (const [client, filter] of this.subscribers) {
      if (client.readyState !== WebSocket.OPEN) continue;

      const match = this.matchesFilter(filter, event, chain);

      if (!match) {
        // Only intent_created mismatches are attributable to the capability
        // predicate (chain-filter drops were never metered — unchanged).
        if (
          filter.solver !== null &&
          !filter.wantAll &&
          event.type === "intent_created" &&
          (event as { intent?: unknown }).intent !== undefined
        ) {
          try { this.metricsService?.incWsFiltered(filter.solver.solverAddress); } catch { /* noop */ }
        }
        continue;
      }

      client.send(payload);

      if (filter.solver !== null && !filter.wantAll) {
        try { this.metricsService?.incWsDelivered(filter.solver.solverAddress); } catch { /* noop */ }
      }
    }
  }

  /**
   * Accept a client connection.
   *
   * @param client  - The accepted socket.
   * @param request - The HTTP upgrade request (supplied by the `ws` adapter);
   *   only its `Sec-WebSocket-protocol` header is used, to negotiate the
   *   protocol version (issue #456). Absent in unit tests, which therefore
   *   exercise the documented "no header → v1" default.
   */
  handleConnection(client: WebSocket, request?: IncomingMessage) {
    // ── Protocol version negotiation (issue #456) ──────────────────────────
    // Runs before anything is registered: an unsupported version must never
    // reach the subscriber set, the connection gauge, or the message pump.
    const negotiation = negotiateFromRequest(request);
    if (!negotiation.ok) {
      logger.warn(
        `ws closing connection: unsupported protocol version (requested=${negotiation.requested.join(", ")})`,
      );
      client.close(
        WS_CLOSE_UNSUPPORTED_PROTOCOL,
        "unsupported protocol version — see docs/asyncapi.yaml",
      );
      return;
    }

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

    const currentSeq = this.seqMirror;

    this.sendFrame(client, {
      type: "connected",
      message: "Vortex intent stream",
      seq: currentSeq,
      protocol: negotiation.protocol,
    });

    // Send the initial snapshot asynchronously — the client receives it
    // immediately after the "connected" message.
    Promise.resolve(this.intentsService.getByState("open"))
      .then((open) => {
        this.sendFrame(client, {
          type: "snapshot",
          intents: open.slice(0, 20),
          seq: currentSeq,
        });
      })
      .catch(() => {
        /* snapshot failure is non-fatal — client can re-fetch via REST */
      });

    logger.info(`ws client connected (subscribers=${this.subscribers.size})`);
  }

  /**
   * Send one control frame to one client.
   *
   * Central choke point so that every non-broadcast frame gets the same
   * readyState guard and, outside production, the same schema validation
   * (issue #456). Broadcast payloads are validated once in
   * {@link broadcast} instead of once per subscriber.
   */
  private sendFrame(client: WebSocket, frame: Record<string, unknown>): void {
    if (client.readyState !== WebSocket.OPEN) return;
    if (wsValidationEnabled()) {
      const result = validateServerFrame(frame);
      if (!result.ok) {
        logger.warn(`ws frame failed schema validation: ${result.error}`);
      }
    }
    client.send(JSON.stringify(frame));
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
   *
   * Outside production every message is additionally checked against
   * `clientMessageSchemas` (issue #456). Validation is advisory — a mismatch
   * is logged loudly but handling is unchanged, so the check can never alter
   * the wire protocol of a development or test run.
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

    if (wsValidationEnabled()) {
      const result = validateClientMessage(msg);
      if (!result.ok) {
        logger.warn(`ws invalid client message: ${result.error}`);
      }
    }

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
      this.sendFrame(client, { type: "subscribed", filter: { all: true } });
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
      this.sendFrame(client, {
        type: "subscribe_rejected",
        reason: `Maximum subscription limit of ${maxSubs} reached for this connection`,
      });
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
      this.sendFrame(client, {
        type: "subscribe_rejected",
        reason: `chains array may contain at most ${maxChains} values`,
      });
      return;
    }

    const validChains = rawChains.filter(
      (c): c is SupportedChain =>
        typeof c === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(c),
    );

    filter.chains = new Set(validChains);
    filter.subscriptionCount += 1;

    logger.debug(`ws client subscribed to chains: ${validChains.join(", ") || "(none)"}`);

    this.sendFrame(client, {
      type: "subscribed",
      filter: { chains: validChains },
    });
  }

  /**
   * Process a `{ type: "replay", fromSeq: number }` message.
   *
   * Events are read from the {@link ReplayStore} (issue #457) and passed
   * through this connection's filter **server-side** before being sent, so a
   * replayed window respects chain/solver scoping exactly like the live feed
   * and a client never receives events it did not subscribe to. The window is
   * bounded by the store's retention — `replay_too_old` is the reset signal
   * when `fromSeq` predates it.
   */
  private async handleReplay(client: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const fromSeq = typeof msg.fromSeq === "number" ? msg.fromSeq : null;
    if (fromSeq === null || !Number.isInteger(fromSeq) || fromSeq < 0) {
      logger.debug("ws replay ignored: fromSeq missing or invalid");
      return;
    }

    if (client.readyState !== WebSocket.OPEN) return;

    let oldest: number;
    try {
      oldest = await this.replayStore.oldestSeq();
    } catch (err) {
      // Store outage: log and emit nothing. Emitting `replay_too_old` would
      // need an `oldestAvailableSeq >= 1` we cannot honestly report (the
      // documented minimum), and silently returning keeps the dispatcher —
      // which is fire-and-forget — free of unhandled rejections. The live
      // feed is unaffected; the client falls back to its snapshot.
      logger.warn(`ws replay ignored: replay store unavailable (${(err as Error).message})`);
      return;
    }

    if (oldest !== -1 && fromSeq < oldest - 1) {
      this.sendFrame(client, {
        type: "replay_too_old",
        fromSeq,
        oldestAvailableSeq: oldest,
      });
      logger.debug(`ws replay_too_old: fromSeq=${fromSeq} oldestAvailable=${oldest}`);
      return;
    }

    let events: SequencedEvent[];
    try {
      events = await this.replayStore.since(fromSeq);
    } catch (err) {
      logger.warn(`ws replay ignored: replay store unavailable (${(err as Error).message})`);
      return;
    }

    const filter = this.subscribers.get(client);
    const matched = filter
      ? events.filter((event) => this.matchesFilter(filter, event))
      : events;

    this.sendFrame(client, {
      type: "replay_start",
      fromSeq,
      count: matched.length,
    });

    // Replayed events were schema-checked once when they were broadcast, so
    // they are sent directly here — re-validating a 10k-event burst per
    // client would dominate the replay budget (issue #457).
    for (const event of matched) {
      if (client.readyState !== WebSocket.OPEN) break;
      client.send(JSON.stringify(event));
    }

    this.sendFrame(client, {
      type: "replay_end",
      count: matched.length,
    });

    logger.debug(`ws replay complete: fromSeq=${fromSeq} count=${matched.length}`);
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
      this.sendFrame(client, {
        type: "auth_error",
        reason: "auth payload requires solver, timestamp, and signature",
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - timestamp);
    if (skew > 300) {
      this.sendFrame(client, { type: "auth_error", reason: "stale or future auth timestamp" });
      return;
    }

    const solverRecord = await this.solversService.get(solver);
    if (!solverRecord || !solverRecord.isActive) {
      this.sendFrame(client, {
        type: "auth_error",
        reason: "solver not registered or inactive",
      });
      return;
    }

    try {
      verifyStellarSignature(solver, buildWsAuthMessage(solver, timestamp), signature);
    } catch {
      this.sendFrame(client, { type: "auth_error", reason: "invalid solver signature" });
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

    this.sendFrame(client, { type: "auth_ok" });

    // Send scoped snapshot of currently-eligible intents (issue #436).
    try {
      const eligible = this.intentIndex.getEligibleFor(solverRecord);
      this.sendFrame(client, {
        type: "eligible_snapshot",
        intents: eligible,
        count: eligible.length,
      });
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
   * Assign a monotonically increasing sequence number, persist the event in
   * the replay store (issue #457), then deliver it to every subscriber whose
   * filter matches.
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

    // Assign the sequence number and persist the event in one step
    // (issue #457). The store is the authority for `seq`, so replicas
    // sharing a Redis-backed log never collide; a store outage degrades
    // replay (logged loudly) instead of dropping the live feed.
    let sequencedEvent: SequencedEvent;
    try {
      sequencedEvent = await this.replayStore.append(event);
    } catch (err) {
      sequencedEvent = { ...event, seq: this.seqMirror + 1 } as SequencedEvent;
      logger.warn(
        `ws replay store append failed — event delivered but not replayable: ${(err as Error).message}`,
      );
    }
    if (sequencedEvent.seq > this.seqMirror) this.seqMirror = sequencedEvent.seq;

    // Update the capability index before delivery so a racing replay or
    // eligible-intents call sees fresh state.
    this.updateIndexForEvent(event);

    // Issue #456 — validate the sequenced event once per broadcast (not once
    // per subscriber) outside production. Advisory only: an event that no
    // longer matches its documented schema is logged loudly and still sent.
    if (wsValidationEnabled()) {
      try {
        const result = validateServerFrame(sequencedEvent);
        if (!result.ok) {
          logger.warn(`ws broadcast frame failed schema validation: ${result.error}`);
        }
      } catch {
        // Validation must never break a broadcast.
      }
    }

    logger.debug(`ws broadcast type=${event.type} seq=${sequencedEvent.seq} subscribers=${this.subscribers.size}`);

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

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [client] of this.subscribers) {
      client.close(WS_CLOSE_GOING_AWAY, "Server shutting down");
      this.removeSubscriber(client);
    }
    // Release the replay store's resources (no-op in memory mode; disconnects
    // the Redis client when WS_REPLAY_STORE=redis — issue #457).
    void this.replayStore.close?.();
  }
}
