import { Controller, Get, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { IntentFeedService } from "./feed/intent-feed.service";
import { FeedClient } from "./feed/feed.types";
import { SUPPORTED_CHAINS, SupportedChain, INTENT_STATES, IntentState } from "./intents.types";
import { resolveClientIp } from "./ws/connection-state";
import { AppConfig } from "../config/configuration";
import { logger } from "../common/logger";

/**
 * Server-Sent Events intent feed (issue #433).
 *
 * `GET /api/v1/stream/intents` streams intent lifecycle events over SSE.
 * Event IDs equal the gateway sequence numbers, so a client can resume with
 * `Last-Event-ID` after a disconnect.  The feed is transport-agnostic: this
 * controller is a thin adapter over {@link IntentFeedService}, sharing
 * sequencing, replay, filtering and connection accounting with the WebSocket
 * feed.
 *
 * RFQ remains WebSocket-only — this endpoint is a read-only intent feed.
 */
@Controller("api/v1/stream")
export class IntentsSseController {
  constructor(
    private readonly feed: IntentFeedService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.sseConfig = config.get("sse", { infer: true });
    this.trustProxyHops = config.get("ws", { infer: true }).trustProxyHops;
  }

  private readonly sseConfig: AppConfig["sse"];
  private readonly trustProxyHops: number;

  @Get("intents")
  async stream(
    @Req() req: Request,
    @Res() res: Response,
    @Query("chains") chains?: string,
    @Query("state") state?: string,
    @Query("user") user?: string,
  ): Promise<void> {
    // ── SSE headers ─────────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    const ip = resolveClientIp(req.socket?.remoteAddress, req.headers?.["x-forwarded-for"], this.trustProxyHops);

    // ── Build the subscription filter ───────────────────────────────────────
    const filter = IntentsSseController.buildFilter(chains, state, user);

    const client = new SseFeedClient(res, ip, this.sseConfig.maxBufferBytes);
    const admission = this.feed.addClient(client, filter);
    if (!admission.ok) {
      res.write(`event: error\ndata: ${JSON.stringify({ reason: admission.reason })}\n\n`);
      res.end();
      return;
    }

    // ── Initial connected event ─────────────────────────────────────────────
    const currentSeq = this.feed.currentSeq;
    res.write(`event: connected\ndata: ${JSON.stringify({ seq: currentSeq })}\n\n`);

    // ── Last-Event-ID resumption ────────────────────────────────────────────
    const lastEventId = IntentsSseController.parseLastEventId(req.headers["last-event-id"]);
    if (lastEventId !== null) {
      const result = this.feed.replaySince(lastEventId, client);
      if (result.tooOld) {
        // The requested event is older than the replay buffer — tell the
        // client to reset and re-fetch a fresh snapshot.
        res.write(`event: reset\ndata: ${JSON.stringify({ reason: "replay_too_old", oldestAvailableSeq: result.oldestSeq })}\n\n`);
      } else {
        for (const event of result.events) {
          // Replayed events go through the same adapter as live ones, so they
          // carry the same `id:` and framing. A client cannot tell a replayed
          // event from a live one, which is exactly what resumption needs.
          if (!client.send(JSON.stringify(event), event.seq)) break;
        }
      }
    }

    // ── Heartbeat ───────────────────────────────────────────────────────────
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, this.sseConfig.heartbeatMs);

    // ── Cleanup on disconnect ────────────────────────────────────────────────
    req.on("close", () => {
      clearInterval(heartbeat);
      this.feed.removeClient(client);
      client.close();
      logger.debug(`sse client disconnected (ip=${ip})`);
    });
  }

  /**
   * Build a feed filter from the SSE query parameters.
   *
   * `chains`  — comma-separated source chains (matches intent.srcChain).
   * `state`   — comma-separated intent states (matches intent.state).
   * `user`    — comma-separated user addresses (matches intent.user).
   *
   * All values are validated against the supported sets; invalid values are
   * silently dropped (mirroring the WS subscribe behaviour).
   */
  private static buildFilter(chains?: string, state?: string, user?: string) {
    const chainSet = new Set<SupportedChain>();
    if (chains) {
      for (const c of chains.split(",")) {
        const trimmed = c.trim();
        if ((SUPPORTED_CHAINS as readonly string[]).includes(trimmed)) {
          chainSet.add(trimmed as SupportedChain);
        }
      }
    }

    const stateSet = new Set<IntentState>();
    if (state) {
      for (const s of state.split(",")) {
        const trimmed = s.trim();
        if ((INTENT_STATES as readonly string[]).includes(trimmed)) {
          stateSet.add(trimmed as IntentState);
        }
      }
    }

    const userSet = new Set<string>();
    if (user) {
      for (const u of user.split(",")) {
        const trimmed = u.trim();
        if (trimmed) userSet.add(trimmed);
      }
    }

    return {
      chains: chainSet.size > 0 ? chainSet : null,
      solver: null,
      wantAll: false,
      users: userSet.size > 0 ? userSet : null,
      states: stateSet.size > 0 ? stateSet : null,
      subscriptionCount: 0,
    };
  }

  /** Parse the `Last-Event-ID` header, returning null when absent/invalid. */
  private static parseLastEventId(raw: string | string[] | undefined): number | null {
    if (!raw || Array.isArray(raw)) return null;
    const seq = Number(raw);
    if (!Number.isInteger(seq) || seq < 0) return null;
    return seq;
  }
}

/**
 * SSE adapter that bridges an HTTP response to the feed service's
 * {@link FeedClient} interface (issue #433).
 *
 * `send` frames the event as `id: <seq>\ndata: <json>\n\n` — the `id` is what
 * makes `Last-Event-ID` resumption work, so every event this adapter writes
 * must be framed, whether it came from the live broadcast path or from replay.
 * Writing the feed's bare JSON straight to the response would produce a stream
 * the browser `EventSource` cannot parse and could never resume from.
 *
 * `send` returns `false` when the response's buffered bytes exceed the
 * configured backpressure limit, signalling the feed service to disconnect the
 * slow client.
 */
class SseFeedClient implements FeedClient {
  readonly id: string;
  readonly ip: string;
  private closed = false;

  constructor(
    private readonly res: Response,
    ip: string,
    private readonly maxBufferBytes: number,
  ) {
    this.id = randomUUID();
    this.ip = ip;
  }

  send(payload: string, seq: number): boolean {
    if (this.closed) return false;
    this.res.write(`id: ${seq}\ndata: ${payload}\n\n`);
    // writableLength is the number of bytes buffered in the response's
    // internal buffer.  When a slow client stops reading, it grows past the
    // limit and we disconnect rather than buffer without bound.
    if (this.res.writableLength > this.maxBufferBytes) {
      return false;
    }
    return true;
  }

  close(): void {
    this.closed = true;
    this.res.end();
  }
}
