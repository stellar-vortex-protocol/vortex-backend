import { Inject, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
  WS_MAX_FILTER_CHAINS,
  WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "../config/limits.config";
import configuration, { AppConfig } from "../config/configuration";
import { verifyHs256Jwt } from "../common/jwt";
import { Backplane, SequencedEvent, WS_BACKPLANE } from "./backplane/backplane.types";
import { MemoryBackplane } from "./backplane/memory.backplane";
import { ConnectionState, resolveClientIp, EncodingFormat } from "./ws/connection-state";
import { EncodingCache } from "./ws/encoding-cache";
import { ConnectionState, resolveClientIp } from "./ws/connection-state";
import { IntentFeedService } from "./feed/intent-feed.service";
import { FeedClient, FeedFilter } from "./feed/feed.types";
import { randomUUID } from "node:crypto";

export type { SequencedEvent } from "./backplane/backplane.types";
export { EventRingBuffer } from "./event-ring-buffer";

/** Read WS_HEARTBEAT_INTERVAL_MS from the environment, falling back to 30 s. */
function resolveHeartbeatIntervalMs(): number {
  const parsed = Number(process.env.WS_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : HEARTBEAT_INTERVAL_MS;
}

/**
 * WebSocket adapter over the transport-agnostic {@link IntentFeedService}
 * (issue #433).
 *
 * The feed service owns sequencing, replay, filtering, delivery and connection
 * accounting.  This class owns only the WebSocket protocol: the upgrade
 * handshake, the `subscribe` / `replay` / `auth` message frames, the
 * solver-JWT handshake, and the ping/pong heartbeat.
 */
// maxPayload is enforced by `ws` itself (close 1009). Read from the
// environment because decorator options are evaluated at import time;
// handleMessage re-checks against the validated config.
@WebSocketGateway({ path: "/ws", maxPayload: configuration().ws.maxPayloadBytes })
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  /** Per-connection identity, rate-limit and outbound-queue state (issue #455). */
  private readonly connections = new Map<WebSocket, ConnectionState>();
  /** Maps a live WebSocket to its feed-service client wrapper. */
  private readonly feedClients = new Map<WebSocket, WsFeedClient>();
  private readonly authenticatedSolver = new WeakMap<WebSocket, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private heartbeatTimer: any;
  private readonly wsConfig: AppConfig["ws"];
  private readonly jwtSecret: string;

  /** Fan-out + global sequencing (issue #454): memory or Redis Streams. */
  private readonly backplane: Backplane;
  /** Serialises local delivery so events reach clients in `seq` order. */
  private deliveryChain: Promise<void> = Promise.resolve();

  private nextSeq = 1;

  /** Configured heartbeat interval in milliseconds (default 30 000). */
  public readonly heartbeatIntervalMs: number;

  /** Number of connections terminated in the most recent heartbeat cycle. */
  private lastHeartbeatTerminatedCount = 0;

  /** Ring buffer storing the last REPLAY_BUFFER_SIZE broadcast events. */
  private readonly ringBuffer = new EventRingBuffer(REPLAY_BUFFER_SIZE);

  /** Encoding cache: serialize once per format, not per client (Activity 1). */
  private readonly encodingCache = new EncodingCache(REPLAY_BUFFER_SIZE);

  /** Graceful shutdown state (Activity 2). */
  private draining = false;
  private drainStartedAt = 0;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentIndex: IntentCapabilityIndex,
    private readonly feed: IntentFeedService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() config?: ConfigService<AppConfig, true>,
    @Optional() @Inject(WS_BACKPLANE) backplane?: Backplane,
  ) {
    const defaults = configuration();
    this.wsConfig = config?.get("ws", { infer: true }) ?? defaults.ws;
    this.jwtSecret = config?.get("authJwtSecret", { infer: true }) ?? defaults.authJwtSecret;
    this.heartbeatIntervalMs = resolveHeartbeatIntervalMs();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.backplane = this.createBackplane();
    if (this.backplane) {
      this.backplane.subscribe((event) => {
        const type = typeof event.type === "string" ? event.type : "";
        if (!type) return;
        this.dispatchRemoteEvent(event as Record<string, unknown>);
      });
    }
    logger.info(`ws heartbeat started (backplane=${this.feed.backplaneHealth().mode})`);
  }

  /** Backplane health for /health (issue #454). */
  backplaneHealth() {
    return this.feed.backplaneHealth();
  }

  /**
   * Broadcast an event to every connected client (WS and SSE) on every replica.
   *
   * Activity 1: Uses encoding cache — serializes once per format, not per client.
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
    seq: number,
    chain: SupportedChain | null,
    event: { type: string; [key: string]: unknown },
  ) {
    for (const [client, filter] of this.subscribers) {
      if (client.readyState !== WebSocket.OPEN) continue;

      // Opt-out: solver requested full feed.
      if (filter.wantAll) {
        this.sendEncoded(client, seq, event);
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
            this.sendEncoded(client, seq, event);
            try { this.metricsService?.incWsDelivered(solverPredicate.solverAddress); } catch { /* noop */ }
          } else {
            try { this.metricsService?.incWsFiltered(solverPredicate.solverAddress); } catch { /* noop */ }
          }
          continue;
        }

        // State-transition events: the solver already filtered on intent_created,
        // so we pass them through to keep the feed self-consistent.
        this.sendEncoded(client, seq, event);
        try { this.metricsService?.incWsDelivered(solverPredicate.solverAddress); } catch { /* noop */ }
        continue;
      }

      // No filter set → full unfiltered feed (backward-compatible default).
      if (filter.chains === null) {
        this.sendEncoded(client, seq, event);
        continue;
      }

      // Chain couldn't be resolved → deliver to everyone (safe default).
      if (chain === null) {
        this.sendEncoded(client, seq, event);
        continue;
      }

      // Only send if the event's chain is in this subscriber's filter.
      if (filter.chains.has(chain)) {
        this.sendEncoded(client, seq, event);
      }
    }
  }

  handleConnection(client: WebSocket) {
    this.subscribers.set(client, {
      chains: null,
      solver: null,
      wantAll: false,
      subscriptionCount: 0,
    });
  /**
   * Send an event to a client using its negotiated encoding format (Activity 1).
   * 
   * Retrieves pre-serialized payload from encoding cache, avoiding redundant
   * serialization work. At 10k connections with msgpack, this saves 9,999
   * msgpackEncode() calls per broadcast.
   */
  private sendEncoded(client: WebSocket, seq: number, event: Record<string, unknown>): void {
    const state = this.connections.get(client);
    if (!state) {
      // Fallback for connections without state (shouldn't happen)
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ seq, ...event }));
      }
      return;
    }

    const payload = this.encodingCache.get(seq, event, state.encoding);
    const result = state.send(payload);
    
    if (result === "dropped_oldest") {
      this.metricsService?.wsOutboundDropped.inc();
    } else if (result === "disconnected") {
      this.metricsService?.wsSlowConsumerDisconnects.inc();
      logger.warn(`ws slow consumer disconnected (ip=${state.ip}, queue full)`);
      this.removeSubscriber(client);
    }
  }

  /**
   * Admits a connection (issue #455): enforces WS_MAX_CONNECTIONS and the
   * per-IP limit (IP resolved through WS_TRUST_PROXY_HOPS), creates the
   * per-connection state, and accepts an optional solver JWT from
   * `?token=` or `Authorization: Bearer` (anonymous connections stay allowed).
   * 
   * Activity 1: Negotiates encoding format via Sec-WebSocket-Protocol header.
   * Activity 2: Rejects new connections when draining.
   * Delegates to the feed service, which owns sequencing and delivery.  This
   * method exists so existing callers (controller, sweeper) keep working
   * against the gateway's public surface.
   */
  broadcast(event: { type: string; [key: string]: unknown }): Promise<void> {
    return this.feed.broadcast(event);
  }

  private static isSupportedChain(value: unknown): value is SupportedChain {
    return typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value);
  }

  /**
   * Admit a WebSocket connection (issue #455): enforces the shared connection
   * limits through the feed service, creates the per-connection state, and
   * accepts an optional solver JWT from `?token=` or `Authorization: Bearer`.
   */
  handleConnection(client: WebSocket, request?: IncomingMessage) {
    // Activity 2: Reject new connections during graceful shutdown
    if (this.draining) {
      client.close(1001, "Server draining");
      this.metricsService?.wsConnectionsRejected.inc({ reason: "draining" });
      return;
    }

    const ip = resolveClientIp(
      request?.socket?.remoteAddress,
      request?.headers?.["x-forwarded-for"],
      this.wsConfig.trustProxyHops,
    );

    const filter: FeedFilter = { chains: null, solver: null, wantAll: false, users: null, states: null, subscriptionCount: 0 };
    const state = new ConnectionState(
      client,
      ip,
      { perSec: this.wsConfig.rateLimitPerSec, burst: this.wsConfig.rateLimitBurst },
      {
        queueMax: this.wsConfig.outboundQueueMax,
        bufferBytes: this.wsConfig.outboundBufferBytes,
        policy: this.wsConfig.slowConsumerPolicy,
      },
    );

    // Activity 1: Negotiate encoding format from Sec-WebSocket-Protocol header
    const protocols = request?.headers?.["sec-websocket-protocol"];
    const encoding = this.negotiateEncoding(protocols);
    state.encoding = encoding;

    this.connections.set(client, state);
    this.connectionsPerIp.set(ip, perIp + 1);
    this.subscribers.set(client, { chains: null, solver: null, wantAll: false, subscriptionCount: 0 });
    this.alive.set(client, true);
    const feedClient = new WsFeedClient(client, ip, state, this.metricsService);
    const admission = this.feed.addClient(feedClient, filter);
    if (!admission.ok) {
      state.close();
      this.metricsService?.wsConnectionsRejected.inc({ reason: admission.reason ?? "max_connections" });
      client.close(1013, admission.reason === "per_ip" ? "Too many connections from this IP" : "Server at capacity");
      return;
    }

    this.connections.set(client, state);
    this.feedClients.set(client, feedClient);
    this.metricsService?.incWsConnection();

    client.on("message", (raw) => {
      void this.handleMessage(client, raw);
    });

    client.on("pong", () => {
      feedClient.alive = true;
    });

    client.on("error", () => {
      this.removeSubscriber(client);
      logger.debug(
        `ws client error/drop — active subscribers: ${this.feed.connectionCount}`,
      );
    });

    const currentSeq = this.feed.currentSeq;

    this.send(
      client,
      JSON.stringify({
        type: "connected",
        message: "Vortex intent stream",
        seq: currentSeq,
        encoding,
      }),
    );

    // Send the initial snapshot asynchronously — the client receives it
    // immediately after the "connected" message.
    Promise.resolve(this.intentsService.getByState("open"))
      .then((open) => {
        this.send(client, JSON.stringify({ type: "snapshot", intents: open.slice(0, 20), seq: currentSeq }));
      })
      .catch(() => {
        /* snapshot failure is non-fatal — client can re-fetch via REST */
      });

    const token = IntentsGateway.bearerToken(request);
    if (token) void this.authenticateJwt(client, token);

    logger.info(`ws client connected (subscribers=${this.subscribers.size}, encoding=${encoding})`);
  }

  /**
   * Negotiate encoding format from Sec-WebSocket-Protocol header (Activity 1).
   * 
   * Clients send: `Sec-WebSocket-Protocol: vortex.v1+msgpack`
   * Server responds with the negotiated protocol in upgrade response.
   * 
   * @returns "msgpack" if client requests it, otherwise "json" (default)
   */
  private negotiateEncoding(protocols: string | string[] | undefined): EncodingFormat {
    if (!protocols) return "json";
    const requested = Array.isArray(protocols) ? protocols : protocols.split(",").map(p => p.trim());
    if (requested.includes("vortex.v1+msgpack")) {
      return "msgpack";
    }
    return "json";
    logger.info(`ws client connected (subscribers=${this.feed.connectionCount})`);
  }

  /** JWT from `?token=` or `Authorization: Bearer` on the upgrade request. */
  private static bearerToken(request?: IncomingMessage): string | null {
    const auth = request?.headers?.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
    try {
      return new URL(request?.url ?? "", "http://localhost").searchParams.get("token");
    } catch {
      return null;
    }
  }

  /**
   * Queues `payload` for `client` through its backpressure-aware state
   * (issue #455), counting slow-consumer drops and disconnects.
   */
  private send(client: WebSocket, payload: string): void {
    const state = this.connections.get(client);
    if (!state) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
      return;
    }
    const result = state.send(payload);
    if (result === "dropped_oldest") {
      this.metricsService?.wsOutboundDropped.inc();
    } else if (result === "disconnected") {
      this.metricsService?.wsSlowConsumerDisconnects.inc();
      logger.warn(`ws slow consumer disconnected (ip=${state.ip}, queue full)`);
      this.removeSubscriber(client);
    }
  }

  handleDisconnect(client: WebSocket) {
    this.removeSubscriber(client);
    logger.info(`ws client disconnected (subscribers=${this.feed.connectionCount})`);
  }

  /** Drop a client from the feed service and keep the connection gauge honest. */
  private removeSubscriber(client: WebSocket): void {
    const state = this.connections.get(client);
    if (state) {
      state.close();
      this.connections.delete(client);
    }
    const feedClient = this.feedClients.get(client);
    if (feedClient) {
      this.feed.removeClient(feedClient);
      this.feedClients.delete(client);
    }
    this.authenticatedSolver.delete(client);
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
   */
  private async handleMessage(client: WebSocket, raw: import("ws").RawData): Promise<void> {
    if (client.readyState !== WebSocket.OPEN) return;
    const size = Array.isArray(raw)
      ? raw.reduce((n, b) => n + b.length, 0)
      : (raw as Buffer | ArrayBuffer).byteLength;
    if (size > this.wsConfig.maxPayloadBytes) {
      client.close(1009, "Message too big");
      return;
    }

    const state = this.connections.get(client);
    if (state && !state.bucket.take()) {
      state.violations += 1;
      if (state.violations >= this.wsConfig.rateLimitMaxViolations) {
        this.metricsService?.wsRateLimited.inc({ action: "disconnected" });
        client.close(1008, "Rate limit exceeded");
        return;
      }
      this.metricsService?.wsRateLimited.inc({ action: "rejected" });
      this.send(client, JSON.stringify({ type: "rate_limited", retryAfterMs: Math.ceil(1000 / this.wsConfig.rateLimitPerSec) }));
      return;
    }

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
        this.handleReplay(client, msg);
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
   * Issue #476: enforces two per-connection limits.
   */
  private handleSubscribe(client: WebSocket, msg: Record<string, unknown>): void {
    const feedClient = this.feedClients.get(client);
    if (!feedClient) return;
    const current = this.feed.getFilter(feedClient);
    if (!current) return;

    // all=true: opt out of capability filtering.
    if (msg.all === true) {
      const existing = this.subscribers.get(client) ?? {
        chains: null,
        solver: null,
        wantAll: false,
        subscriptionCount: 0,
      };
      const existing = this.subscribers.get(client) ?? { chains: null, solver: null, wantAll: false, subscriptionCount: 0 };
      this.subscribers.set(client, { ...existing, wantAll: true });
      this.feed.updateClientFilter(feedClient, { ...current, wantAll: true });
      logger.debug("ws client opted out of capability filtering (all=true)");
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, JSON.stringify({ type: "subscribed", filter: { all: true } }));
      }
      return;
    }

    if (!Array.isArray(msg.chains)) {
      logger.debug("ws subscribe ignored: chains field missing or not an array");
      return;
    }

    // ── Limit 1: max subscriptions per connection (issue #476) ───────────────
    const maxSubs = parseInt(
      process.env.WS_MAX_SUBSCRIPTIONS ?? String(WS_MAX_SUBSCRIPTIONS_PER_CONNECTION),
      10,
    );
    if (current.subscriptionCount >= maxSubs) {
      logger.warn(
        `ws subscribe_rejected: connection has reached the max subscription limit (${maxSubs})`,
      );
      if (client.readyState === WebSocket.OPEN) {
        this.send(client,
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
        this.send(client,
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
    // An explicit chain filter replaces any solver capability predicate.
    this.feed.updateClientFilter(feedClient, {
      ...current,
      chains: new Set(validChains),
      solver: null,
      wantAll: false,
      subscriptionCount: current.subscriptionCount + 1,
    });

    logger.debug(`ws client subscribed to chains: ${validChains.join(", ") || "(none)"}`);

    if (client.readyState === WebSocket.OPEN) {
      this.send(client,
        JSON.stringify({
          type: "subscribed",
          filter: { chains: validChains },
        }),
      );
    }
  }

  /**
   * Process a `{ type: "replay", fromSeq: number }` message.
   */
  private handleReplay(client: WebSocket, msg: Record<string, unknown>): void {
    const fromSeq = typeof msg.fromSeq === "number" ? msg.fromSeq : null;
    if (fromSeq === null || !Number.isInteger(fromSeq) || fromSeq < 0) {
      logger.debug("ws replay ignored: fromSeq missing or invalid");
      return;
    }

    if (client.readyState !== WebSocket.OPEN) return;

    const feedClient = this.feedClients.get(client);
    if (!feedClient) return;

    const result = this.feed.replaySince(fromSeq, feedClient);

    if (result.tooOld) {
      this.send(client,
        JSON.stringify({
          type: "replay_too_old",
          fromSeq,
          oldestAvailableSeq: result.oldestSeq,
        }),
      );
      logger.debug(`ws replay_too_old: fromSeq=${fromSeq} oldestAvailable=${result.oldestSeq}`);
      return;
    }

    this.send(client,
      JSON.stringify({
        type: "replay_start",
        fromSeq,
        count: result.events.length,
      }),
    );

    for (const event of result.events) {
      if (client.readyState !== WebSocket.OPEN) break;
      this.send(client, JSON.stringify(event));
    }

    if (client.readyState === WebSocket.OPEN) {
      this.send(client,
        JSON.stringify({
          type: "replay_end",
          count: result.events.length,
        }),
      );
    }

    logger.debug(`ws replay complete: fromSeq=${fromSeq} count=${result.events.length}`);
  }

  /**
   * Authenticate a solver connection and install a capability predicate.
   */
  private async handleAuth(client: WebSocket, payload: Record<string, unknown>) {
    if (typeof payload.token === "string") {
      await this.authenticateJwt(client, payload.token);
      return;
    }
    const solver = typeof payload.solver === "string" ? payload.solver : "";
    const timestamp = payload.timestamp;
    const signature = typeof payload.signature === "string" ? payload.signature : "";

    if (!solver || !signature || typeof timestamp !== "number") {
      this.send(client, JSON.stringify({ type: "auth_error", reason: "auth payload requires solver, timestamp, and signature" }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - timestamp);
    if (skew > 300) {
      this.send(client, JSON.stringify({ type: "auth_error", reason: "stale or future auth timestamp" }));
      return;
    }

    const solverRecord = await this.solversService.get(solver);
    if (!solverRecord || !solverRecord.isActive) {
      this.send(client, JSON.stringify({ type: "auth_error", reason: "solver not registered or inactive" }));
      return;
    }

    try {
      verifyStellarSignature(solver, buildWsAuthMessage(solver, timestamp), signature);
    } catch {
      this.send(client, JSON.stringify({ type: "auth_error", reason: "invalid solver signature" }));
      return;
    }

    await this.installSolver(client, solverRecord, "signature");
  }

  /**
   * Authenticates with a solver JWT from the SEP-10 flow (issue #455 / #442).
   */
  private async authenticateJwt(client: WebSocket, token: string): Promise<void> {
    const claims = verifyHs256Jwt(token, this.jwtSecret);
    if (!claims) {
      this.send(client, JSON.stringify({ type: "auth_error", reason: "invalid or expired token" }));
      return;
    }
    const solverRecord = await this.solversService.get(claims.sub);
    if (!solverRecord || !solverRecord.isActive) {
      this.send(client, JSON.stringify({ type: "auth_error", reason: "solver not registered or inactive" }));
      return;
    }
    await this.installSolver(client, solverRecord, "jwt");
  }

  /** Binds a verified solver identity to the connection and sends its scoped snapshot. */
  private async installSolver(
    client: WebSocket,
    solverRecord: NonNullable<Awaited<ReturnType<SolversService["get"]>>>,
    method: "signature" | "jwt",
  ): Promise<void> {
    const solver = solverRecord.address;
    const predicate = buildMatchPredicate(solverRecord);
    this.authenticatedSolver.set(client, solver);
    const authFilter = this.subscribers.get(client);
    this.subscribers.set(client, {
      chains: authFilter?.chains ?? null,
      solver: predicate,
      wantAll: authFilter?.wantAll ?? false,
      subscriptionCount: authFilter?.subscriptionCount ?? 0,
    });
    const state = this.connections.get(client);
    if (state) state.identity = solver;
    const feedClient = this.feedClients.get(client);
    if (feedClient) {
      const current = this.feed.getFilter(feedClient);
      if (current) {
        this.feed.updateClientFilter(feedClient, { ...current, solver: predicate });
      }
    }

    this.send(client, JSON.stringify({ type: "auth_ok", method }));

    try {
      const eligible = this.intentIndex.getEligibleFor(solverRecord);
      this.send(client, JSON.stringify({
        type: "eligible_snapshot",
        intents: eligible,
        count: eligible.length,
      }));
    } catch {
      // Non-fatal — solver can fall back to GET /solvers/:address/eligible-intents.
    }

    // Use the predicate's normalized capability lists: a partially-populated
    // solver record must not throw here and take down the auth path.
    logger.info(
      `ws solver auth ok: address=${solver} chains=${predicate.supportedChains.join(",")} tokens=${predicate.supportedTokens.join(",")}`,
    );
  }

  /**
   * Update the capability predicate for all live connections authenticated as
   * the given solver address.
   */
  async updateSolverPredicate(solverAddress: string): Promise<void> {
    await this.feed.updateSolverPredicate(solverAddress);
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
      "auction_price",
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
   * Broadcast an event to every client on every replica (issue #454).
   *
   * The backplane assigns the global sequence number and hands the event
   * back to each replica's {@link deliver}. In memory mode this resolves after
   * local delivery (unchanged behaviour); in redis mode it resolves once the
   * event is queued, so request handlers never wait on Redis.
   */
  async broadcast(event: { type: string; [key: string]: unknown }): Promise<void> {
    await this.backplane.publish(event);
  }

  /** Chains deliveries so async chain lookups cannot reorder events. */
  private enqueueDelivery(event: SequencedEvent): Promise<void> {
    const run = this.deliveryChain.then(() => this.deliver(event));
    this.deliveryChain = run.catch((err: Error) => {
      logger.error(`ws delivery failed: ${err.message}`);
    });
    return this.deliveryChain;
  }

  /**
   * Push a sequenced event into the replay buffer, then deliver it to every
   * subscriber whose filter matches.
   *
   * For authenticated solvers without `all=true`, only intents matching their
   * capability predicate are delivered.  State-transition events (no inlined
   * intent) are always delivered to authenticated subscribers.
   *
   * Side-effects:
   * - Updates the intent index for `intent_created` (add) and terminal-state
   *   events (remove), keeping the capability index fresh without a rebuild.
   */
  private async deliver(sequencedEvent: SequencedEvent): Promise<void> {
    const enqueuedAt = Date.now();
    const { seq, ...event } = sequencedEvent;

    // Update the capability index before delivery so a racing replay or
    // eligible-intents call sees fresh state.
    this.updateIndexForEvent(sequencedEvent);

    // Push into replay buffer before sending.
    this.ringBuffer.push(sequencedEvent);

    logger.debug(`ws broadcast type=${event.type} seq=${seq} subscribers=${this.subscribers.size}`);

    // Resolve the chain once — shared across all subscriber checks.
    const eventChain = await this.getEventChain(sequencedEvent);

    // Activity 1: Pass seq + event separately so encoding cache can serialize
    this.deliverToMatchingSubscribers(seq, eventChain, event);

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
    for (const [client, feedClient] of this.feedClients) {
      if (feedClient.alive) count++;
    }
    return count;
  }

  getSubscriberCount(): number {
    return this.feed.connectionCount;
  }

  /** Returns the current number of active WebSocket subscribers. */
  get subscriberCount(): number {
    return this.feed.connectionCount;
  }

  /**
   * Check if the gateway is draining connections (Activity 2).
   * Used by health indicators to flip readiness during shutdown.
   */
  isDraining(): boolean {
    return this.draining;
  }

  private heartbeat() {
    let terminated = 0;
    for (const [client, feedClient] of this.feedClients) {
      if (!feedClient.alive) {
        client.terminate();
        this.removeSubscriber(client);
        terminated++;
        logger.debug(
          `ws heartbeat terminated dead client (subscribers=${this.feed.connectionCount})`,
        );
        continue;
      }

      feedClient.alive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
    this.lastHeartbeatTerminatedCount = terminated;
    if (terminated > 0) {
      logger.debug(
        `ws heartbeat terminated ${terminated} dead client(s) (subscribers=${this.subscribers.size})`,
      );
    }
        continue;
      }

      feedClient.alive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
    this.lastHeartbeatTerminatedCount = terminated;
    if (terminated > 0) {
      logger.debug(
        `ws heartbeat terminated ${terminated} dead client(s) (subscribers=${this.subscribers.size})`,
      );
    }
  }

  /**
   * Returns the number of connections terminated in the most recent
   * heartbeat cycle. Useful for presence stats and observability.
   */
  getLastTerminatedCount(): number {
    return this.lastHeartbeatTerminatedCount;
  }

  /**
   * Returns the number of connections that missed the last ping and are
   * waiting to be terminated in the next heartbeat cycle ("zombies").
   */
  getZombieCount(): number {
    let count = 0;
    for (const client of this.subscribers.keys()) {
      if (this.alive.get(client) === false) count++;
    }
    return count;
  }

  async onModuleDestroy() {
    // Activity 2: Graceful shutdown with connection draining
    await this.startDraining();

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [client, feedClient] of this.feedClients) {
      this.removeSubscriber(client);
      client.close(1001, "Server shutting down");
    }
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket adapter that bridges a `ws` socket to the feed service's
 * {@link FeedClient} interface (issue #433).
 *
 * `send` applies the per-connection backpressure policy (issue #455) and
 * returns `false` only when the connection should be terminated.
 */
class WsFeedClient implements FeedClient {
  alive = true;
  readonly id: string;
  readonly ip: string;
  /** Number of `subscribe` messages this connection has sent (issue #476). */
  subscriptionCount = 0;

  constructor(
    private readonly socket: WebSocket,
    ip: string,
    private readonly state: ConnectionState,
    private readonly metricsService?: MetricsService,
  ) {
    this.id = randomUUID();
    this.ip = ip;
  }

  send(payload: string): boolean {
    const result = this.state.send(payload);
    if (result === "dropped_oldest") {
      this.metricsService?.wsOutboundDropped.inc();
      return true;
    }
    if (result === "disconnected") {
      this.metricsService?.wsSlowConsumerDisconnects.inc();
      return false;
    }
    return true;
  }

  close(): void {
    this.state.close();
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1001, "Server shutting down");
    }
  }

  /**
   * Begin graceful shutdown (Activity 2): notify all clients and close
   * connections in batches within the termination grace period.
   * 
   * Flow:
   * 1. Set draining flag (rejects new connections)
   * 2. Send server_draining event to all clients with resumeFrom seq
   * 3. Close connections in batches with jittered delays
   * 4. Background workers finish current batch (handled by IntentsSweeperService)
   * 
   * Kubernetes terminationGracePeriodSeconds should be at least DRAIN_TIMEOUT_MS + 5s.
   */
  async startDraining(): Promise<void> {
    if (this.draining) return;
    
    this.draining = true;
    this.drainStartedAt = Date.now();
    
    const drainTimeoutMs = parseInt(process.env.WS_DRAIN_TIMEOUT_MS ?? "25000", 10);
    const currentSeq = this.backplane.health().lastSeq;
    const clientCount = this.subscribers.size;

    logger.warn(`ws draining started: ${clientCount} clients, timeout=${drainTimeoutMs}ms`);

    // Notify all clients to reconnect with resume
    const drainMessage = JSON.stringify({
      type: "server_draining",
      resumeFrom: currentSeq,
      reconnectAfterMs: this.jitter(1000, 5000), // Stagger reconnects
      reason: "graceful_shutdown",
    });

    for (const [client] of this.subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(drainMessage);
        } catch {
          // Best effort notification
        }
      }
    }

    // Close connections in batches to avoid thundering herd
    const batchSize = Math.max(10, Math.ceil(clientCount / 10));
    const clients = Array.from(this.subscribers.keys());
    const batchDelayMs = Math.floor(drainTimeoutMs / Math.ceil(clientCount / batchSize));

    for (let i = 0; i < clients.length; i += batchSize) {
      const batch = clients.slice(i, i + batchSize);
      
      // Wait between batches
      if (i > 0) {
        await this.sleep(batchDelayMs);
      }

      for (const client of batch) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, "Server draining");
        }
        this.removeSubscriber(client);
      }

      logger.info(`ws drain progress: ${Math.min(i + batchSize, clientCount)}/${clientCount} closed`);
    }

    logger.warn(`ws draining complete: all clients closed`);
  }

  /**
   * Generate a jittered delay in [min, max] ms to stagger reconnects.
   */
  private jitter(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Promise-based sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
