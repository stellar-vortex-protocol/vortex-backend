import { Inject, Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { IntentsService } from "../intents.service";
import { SolversService } from "../../solvers/solvers.service";
import { MetricsService } from "../../metrics/metrics.service";
import { createLogger } from "../../common/logger";

const logger = createLogger("IntentFeedService");
import { SUPPORTED_CHAINS, SupportedChain, IntentState } from "../intents.types";
import { buildMatchPredicate, IntentCapabilityIndex, SolverMatchPredicate } from "../solver-intent-matcher";
import configuration, { AppConfig } from "../../config/configuration";
import { Backplane, SequencedEvent, WS_BACKPLANE } from "../backplane/backplane.types";
import { MemoryBackplane } from "../backplane/memory.backplane";
import { EventRingBuffer } from "../event-ring-buffer";
import { FeedClient, FeedAdmission, FeedFilter, FeedReplayResult } from "./feed.types";
import { resolveClientIp } from "../ws/connection-state";
import { verifyStellarSignature } from "../../common/stellar-signature";
import { buildRfqResponseMessage } from "../../common/rfq-signature";
import { RfqQuoteRequest, RfqResponseSignaturePayload, VerifiedRfqQuote } from "../rfq.types";

interface PendingRfq {
  request: RfqQuoteRequest;
  eligibleSolvers: Set<string>;
  responses: Map<string, VerifiedRfqQuote>;
  resolve: (responses: VerifiedRfqQuote[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How many sequenced events to keep in the replay buffer.
 *
 * At typical broadcast volume (a few dozen events/minute in production),
 * 500 events covers many minutes of missed events — more than enough to
 * bridge a transient network blip or container restart without forcing a
 * full snapshot re-fetch.  See issue #433 for the SSE resumption contract.
 */
const REPLAY_BUFFER_SIZE = 500;

/**
 * Transport-agnostic intent feed (issue #433).
 *
 * Owns event sequencing (via the backplane), the replay buffer, subscriber
 * filtering, delivery, and connection accounting.  The WebSocket gateway and
 * the SSE controller are thin adapters over this service, so both feeds share
 * identical ordering, replay, and filtering semantics.
 */
@Injectable()
export class IntentFeedService implements OnModuleDestroy {

  /** Fan-out + global sequencing (issue #454): memory or Redis Streams. */
  private readonly backplane: Backplane;
  /** Serialises local delivery so events reach clients in `seq` order. */
  private deliveryChain: Promise<void> = Promise.resolve();

  /** Ring buffer storing the last REPLAY_BUFFER_SIZE broadcast events. */
  private ringBuffer: EventRingBuffer;

  /** Connected clients and their per-connection filters. */
  private readonly clients = new Map<FeedClient, FeedFilter>();
  private readonly pendingRfqs = new Map<string, PendingRfq>();
  /** Per-IP connection accounting (shared by WS and SSE). */
  private readonly connectionsPerIp = new Map<string, number>();

  private readonly wsConfig: AppConfig["ws"];
  private readonly maxConnections: number;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentIndex: IntentCapabilityIndex,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() config?: ConfigService<AppConfig, true>,
    @Optional() @Inject(WS_BACKPLANE) backplane?: Backplane,
  ) {
    const defaults = configuration();
    this.wsConfig = config?.get("ws", { infer: true }) ?? defaults.ws;
    this.maxConnections = config?.get("wsMaxConnections", { infer: true }) ?? defaults.wsMaxConnections;
    this.ringBuffer = new EventRingBuffer(REPLAY_BUFFER_SIZE);
    this.backplane = backplane ?? new MemoryBackplane();
    void this.backplane.start((event) => this.enqueueDelivery(event)).catch((err: Error) =>
      logger.error("feed backplane failed to start", { err }),
    );
    logger.info("intent feed started", { backplane: this.backplane.mode });
  }

  /**
   * Replace the replay-buffer capacity. Test-only seam: it must be called
   * before the first broadcast, because the buffer is sized at construction.
   */
  setRingBufferCapacity(capacity: number): void {
    this.ringBuffer = new EventRingBuffer(capacity);
  }

  /** Backplane health for /health (issue #454). */
  backplaneHealth() {
    return this.backplane.health();
  }

  // ── Connection accounting ────────────────────────────────────────────────

  /**
   * Admit a client to the feed, enforcing the shared connection limits.
   *
   * The limits are shared across transports: a WS client and an SSE client
   * from the same IP both count toward `maxConnectionsPerIp`, and the total
   * across both transports counts toward `wsMaxConnections`.
   */
  addClient(client: FeedClient, filter: FeedFilter): FeedAdmission {
    const perIp = this.connectionsPerIp.get(client.ip) ?? 0;
    const reject =
      this.maxConnections > 0 && this.clients.size >= this.maxConnections
        ? "max_connections"
        : this.wsConfig.maxConnectionsPerIp > 0 && perIp >= this.wsConfig.maxConnectionsPerIp
          ? "per_ip"
          : null;
    if (reject) {
      this.metricsService?.wsConnectionsRejected.inc({ reason: reject });
      return { ok: false, reason: reject };
    }

    this.clients.set(client, filter);
    this.connectionsPerIp.set(client.ip, perIp + 1);
    this.metricsService?.incWsConnection();
    return { ok: true };
  }

  /** Remove a client from the feed and keep the per-IP accounting honest. */
  removeClient(client: FeedClient): void {
    const filter = this.clients.get(client);
    if (filter === undefined) return;
    this.clients.delete(client);
    const remaining = (this.connectionsPerIp.get(client.ip) ?? 1) - 1;
    if (remaining > 0) this.connectionsPerIp.set(client.ip, remaining);
    else this.connectionsPerIp.delete(client.ip);
    this.metricsService?.decWsConnection();
  }

  /** Update a connected client's filter (e.g. on a new subscription). */
  updateClientFilter(client: FeedClient, filter: FeedFilter): void {
    if (this.clients.has(client)) this.clients.set(client, filter);
  }

  /** Read a connected client's current filter (undefined when not connected). */
  getFilter(client: FeedClient): FeedFilter | undefined {
    return this.clients.get(client);
  }

  /** Number of connected clients (WS + SSE). */
  get connectionCount(): number {
    return this.clients.size;
  }

  // ── Broadcast & delivery ─────────────────────────────────────────────────

  /**
   * Broadcast an event to every client on every replica (issue #454).
   *
   * The backplane assigns the global sequence number and hands the event
   * back to each replica's {@link deliver}.
   */
  broadcast(event: { type: string; [key: string]: unknown }): Promise<void> {
    return this.backplane.publish(event);
  }

  requestRfq(
    request: Omit<RfqQuoteRequest, "requestId" | "deadline">,
    eligibleSolvers: string[],
    windowMs: number,
  ): Promise<VerifiedRfqQuote[]> {
    const eligible = new Set(eligibleSolvers);
    if (eligible.size === 0) return Promise.resolve([]);

    const rfq: RfqQuoteRequest = {
      ...request,
      requestId: randomUUID(),
      deadline: Date.now() + windowMs,
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.completeRfq(rfq.requestId), windowMs);
      this.pendingRfqs.set(rfq.requestId, {
        request: rfq,
        eligibleSolvers: eligible,
        responses: new Map(),
        resolve,
        timer,
      });

      void this.backplane
        .publish({ type: "rfq_request", ...rfq, eligibleSolvers: [...eligible] })
        .catch(() => this.completeRfq(rfq.requestId));
    });
  }

  submitRfqResponse(response: {
    solver: string;
    requestId: string;
    dstAmount: string;
    fee: string;
    expiresAt: number;
    signature: string;
  }): Promise<void> {
    return this.backplane.publish({ type: "rfq_response", ...response });
  }

  private completeRfq(requestId: string): void {
    const pending = this.pendingRfqs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRfqs.delete(requestId);
    pending.resolve([...pending.responses.values()]);
  }

  private deliverRfqRequest(event: SequencedEvent): void {
    const eligibleSolvers = (event as SequencedEvent & { eligibleSolvers?: unknown }).eligibleSolvers;
    if (!Array.isArray(eligibleSolvers)) return;
    const eligible = new Set(eligibleSolvers.filter((solver): solver is string => typeof solver === "string"));
    const { seq, eligibleSolvers: _eligibleSolvers, ...request } = event as SequencedEvent & {
      eligibleSolvers: string[];
    };
    const payload = JSON.stringify({ seq, ...request });

    for (const [client, filter] of this.clients) {
      if (filter.solver && eligible.has(filter.solver.solverAddress)) {
        this.sendToClient(client, payload, seq);
      }
    }
  }

  private acceptRfqResponse(event: SequencedEvent): void {
    const response = event as SequencedEvent & {
      solver?: unknown;
      requestId?: unknown;
      dstAmount?: unknown;
      fee?: unknown;
      expiresAt?: unknown;
      signature?: unknown;
    };
    const { solver, requestId, dstAmount, fee, expiresAt, signature } = response;
    if (
      typeof solver !== "string" ||
      typeof requestId !== "string" ||
      typeof dstAmount !== "string" ||
      typeof fee !== "string" ||
      typeof expiresAt !== "number" ||
      typeof signature !== "string"
    ) return;

    const pending = this.pendingRfqs.get(requestId);
    if (
      !pending ||
      Date.now() >= pending.request.deadline ||
      !pending.eligibleSolvers.has(solver) ||
      pending.responses.has(solver)
    ) return;
    if (!/^\d{1,78}$/.test(dstAmount) || !/^\d{1,78}$/.test(fee) || !Number.isSafeInteger(expiresAt)) return;

    const now = Math.floor(Date.now() / 1000);
    if (expiresAt <= now || expiresAt > now + 60) return;

    try {
      if (BigInt(dstAmount) <= BigInt(fee)) return;
      const payload: RfqResponseSignaturePayload = {
        ...pending.request,
        solver,
        dstAmount,
        fee,
        expiresAt,
      };
      verifyStellarSignature(solver, buildRfqResponseMessage(payload), signature);
    } catch {
      return;
    }

    pending.responses.set(solver, { solver, dstAmount, fee, expiresAt });
  }

  /** Chains deliveries so async chain lookups cannot reorder events. */
  private enqueueDelivery(event: SequencedEvent): Promise<void> {
    const run = this.deliveryChain.then(() => this.deliver(event));
    this.deliveryChain = run.catch((err: Error) => {
      logger.error("feed delivery failed", { err });
    });
    return this.deliveryChain;
  }

  /**
   * Push a sequenced event into the replay buffer, then deliver it to every
   * client whose filter matches.
   */
  private async deliver(sequencedEvent: SequencedEvent): Promise<void> {
    const enqueuedAt = Date.now();
    const { seq, ...event } = sequencedEvent;

    if (event.type === "rfq_request") {
      this.deliverRfqRequest(sequencedEvent);
      return;
    }
    if (event.type === "rfq_response") {
      this.acceptRfqResponse(sequencedEvent);
      return;
    }

    this.updateIndexForEvent(sequencedEvent);
    this.ringBuffer.push(sequencedEvent);

    logger.debug("feed broadcast", { eventType: event.type, seq, clients: this.clients.size });

    const eventChain = await this.getEventChain(sequencedEvent);
    const payload = JSON.stringify(sequencedEvent);
    this.deliverToMatchingClients(payload, seq, eventChain, sequencedEvent);

    try {
      this.metricsService?.observeWsDelivery((Date.now() - enqueuedAt) / 1000);
    } catch {
      // Metrics must never break broadcasts.
    }
  }

  /**
   * Deliver a pre-serialized event payload to every matching client.
   *
   * Delivery rules (evaluated in order):
   * 1. Client set wantAll=true → always deliver.
   * 2. Client has a solver capability predicate → apply it to inlined intents.
   * 3. Client has a plain chain filter → apply chain match.
   * 4. Client has a user filter → apply user match.
   * 5. Client has a state filter → apply state match.
   * 6. No filter → full unfiltered feed (backward-compatible default).
   */
  private deliverToMatchingClients(
    payload: string,
    seq: number,
    chain: SupportedChain | null,
    event: { type: string; [key: string]: unknown },
  ) {
    for (const [client, filter] of this.clients) {
      if (filter.wantAll) {
        this.sendToClient(client, payload, seq);
        continue;
      }

      if (filter.solver !== null) {
        const solverPredicate = filter.solver;
        const inlinedIntent = (event as { intent?: unknown }).intent;

        if (event.type === "intent_created" && inlinedIntent && typeof inlinedIntent === "object") {
          const matches = solverPredicate.matches(inlinedIntent as Parameters<SolverMatchPredicate["matches"]>[0]);
          if (matches) {
            this.sendToClient(client, payload, seq);
            try { this.metricsService?.incWsDelivered(solverPredicate.solverAddress); } catch { /* noop */ }
          } else {
            try { this.metricsService?.incWsFiltered(solverPredicate.solverAddress); } catch { /* noop */ }
          }
          continue;
        }

        this.sendToClient(client, payload, seq);
        try { this.metricsService?.incWsDelivered(solverPredicate.solverAddress); } catch { /* noop */ }
        continue;
      }

      if (filter.chains !== null) {
        if (chain === null || filter.chains.has(chain)) {
          this.sendToClient(client, payload, seq);
        }
        continue;
      }

      if (filter.users !== null) {
        const user = typeof event.user === "string" ? event.user : null;
        if (user !== null && filter.users.has(user)) {
          this.sendToClient(client, payload, seq);
        }
        continue;
      }

      if (filter.states !== null) {
        const state = typeof event.state === "string" ? event.state : null;
        if (state !== null && filter.states.has(state as IntentState)) {
          this.sendToClient(client, payload, seq);
        }
        continue;
      }

      // No filter → full unfiltered feed.
      this.sendToClient(client, payload, seq);
    }
  }

  /** Send to a single client, disconnecting it on backpressure overflow. */
  private sendToClient(client: FeedClient, payload: string, seq: number): void {
    if (!client.send(payload, seq)) {
      logger.warn("feed client exceeded backpressure limit; disconnecting", { clientIp: client.ip });
      this.metricsService?.wsSlowConsumerDisconnects.inc();
      this.removeClient(client);
      client.close();
    }
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  /**
   * Replay buffered events newer than `fromSeq` to a requesting client.
   *
   * Returns `tooOld: true` when `fromSeq` is older than the earliest buffered
   * event — the caller should emit a `reset` (SSE) or `replay_too_old` (WS)
   * and let the client re-fetch a fresh snapshot.
   */
  replaySince(fromSeq: number, client: FeedClient): FeedReplayResult {
    const oldest = this.ringBuffer.oldestSeq();
    if (oldest !== -1 && fromSeq < oldest - 1) {
      return { events: [], tooOld: true, oldestSeq: oldest };
    }
    return { events: this.ringBuffer.since(fromSeq), tooOld: false, oldestSeq: oldest };
  }

  /** Current sequence number (0 when no events have been broadcast). */
  get currentSeq(): number {
    return this.backplane.health().lastSeq;
  }

  // ── Solver capability ───────────────────────────────────────────────────

  /**
   * Update the capability predicate for all live clients authenticated as
   * the given solver address.
   */
  async updateSolverPredicate(solverAddress: string): Promise<void> {
    const solverRecord = await this.solversService.get(solverAddress);
    if (!solverRecord) return;

    const predicate = buildMatchPredicate(solverRecord);
    for (const [client, filter] of this.clients) {
      if (filter.solver !== null && filter.solver.solverAddress === solverAddress) {
        this.clients.set(client, { ...filter, solver: predicate });
      }
    }
    logger.debug("feed solver predicate updated", { solver: solverAddress });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Keep the IntentCapabilityIndex in sync with broadcast events. */
  private updateIndexForEvent(event: { type: string; [key: string]: unknown }): void {
    try {
      if (event.type === "intent_created") {
        const intent = event.intent;
        if (intent) this.intentIndex.addIntent(intent as Parameters<IntentCapabilityIndex["addIntent"]>[0]);
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

  /** Resolve the source chain for an event payload. */
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
        // Lookup failure is non-fatal — deliver to all clients.
      }
      return null;
    }

    return null;
  }

  async onModuleDestroy(): Promise<void> {
    for (const requestId of this.pendingRfqs.keys()) this.completeRfq(requestId);
    await this.backplane.close();
    for (const [client] of this.clients) {
      this.removeClient(client);
      client.close();
    }
  }
}

// Re-export EventRingBuffer for the gateway spec and adapters.
export { EventRingBuffer };
export { resolveClientIp };
export { randomUUID };
