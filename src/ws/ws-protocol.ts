/**
 * WebSocket protocol version negotiation (issue #456).
 *
 * The gateway speaks versioned protocols named `vortex.<major>`. A client
 * offers the versions it understands in the standard
 * `Sec-WebSocket-Protocol` handshake header; the server answers with the one
 * version it will speak, or — when the client only offered versions the
 * server does not know — closes the connection with WebSocket close code
 * `1002` (protocol error) instead of silently serving a different version.
 *
 * Deliberately dependency-free (no Nest, no `ws`) so both the gateway and the
 * unit tests can use it without a running server.
 *
 * @see docs/asyncapi.yaml — the served, machine-readable protocol definition.
 * @see docs/websocket-protocol.md — the human-readable protocol guide.
 */

import type { IncomingMessage } from "node:http";

/** The only protocol version currently served. */
export const WS_PROTOCOL_V1 = "vortex.v1";

/** Every protocol version this build can speak, newest first. */
export const SUPPORTED_WS_PROTOCOLS: readonly string[] = [WS_PROTOCOL_V1];

/**
 * Close code used when the client offered protocol versions the server does
 * not support (RFC 6455 §7.4.1 — 1002 "protocol error").
 */
export const WS_CLOSE_UNSUPPORTED_PROTOCOL = 1002;

/** Close code used for a graceful server shutdown. */
export const WS_CLOSE_GOING_AWAY = 1001;

/** Result of negotiating the subprotocol for one connection. */
export type ProtocolNegotiation =
  | {
      ok: true;
      /** Version the server will speak on this connection. */
      protocol: string;
      /** Protocol tokens the client offered (empty when none were offered). */
      requested: readonly string[];
      /**
       * True when the client sent no `Sec-WebSocket-protocol` header at all
       * and the documented default (v1) was applied.
       */
      defaulted: boolean;
    }
  | {
      ok: false;
      /** Protocol tokens the client offered — none of them is supported. */
      requested: readonly string[];
    };

/**
 * Parse a `Sec-WebSocket-protocol` header value into its individual tokens.
 *
 * @param header - Raw header (Node lowercases header names and collapses
 *   duplicates into an array for some headers, so both shapes are accepted).
 * @returns The offered protocol tokens, or `null` when the header is absent
 *   or empty (i.e. the client requested no subprotocol).
 */
export function parseProtocolHeader(
  header: string | string[] | undefined,
): string[] | null {
  if (header === undefined) return null;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens.length > 0 ? tokens : null;
}

/**
 * Decide which protocol version a connection will use.
 *
 * - No header          → accepted as `vortex.v1` (documented default, keeps
 *                        pre-#456 clients working — this is not a breaking change).
 * - `vortex.v1` offered → v1 is selected regardless of what else is offered.
 * - anything else      → `ok: false`; the caller closes with 1002.
 */
export function negotiateProtocol(
  header: string | string[] | undefined,
): ProtocolNegotiation {
  const requested = parseProtocolHeader(header);

  if (requested === null) {
    return { ok: true, protocol: WS_PROTOCOL_V1, requested: [], defaulted: true };
  }

  const selected = requested.find((token) => SUPPORTED_WS_PROTOCOLS.includes(token));
  if (selected) {
    return { ok: true, protocol: selected, requested, defaulted: false };
  }

  return { ok: false, requested };
}

/**
 * `handleProtocols` hook for the `ws` server.
 *
 * `ws` only calls this when the client offered at least one protocol and
 * echoes whatever it returns in `Sec-WebSocket-Protocol`.
 *
 * When a supported version was offered it is selected. When **none** was, one
 * of the client's own offered tokens is echoed so the handshake completes —
 * the connection is then closed with 1002 in `handleConnection`, which is the
 * only way for the client to actually *observe* that close code. (Answering
 * without a subprotocol makes the standard `ws` client fail the handshake
 * itself with "Server sent no subprotocol" and surface 1006 instead; an
 * HTTP-level rejection surfaces as a transport error, not a close code.)
 *
 * @param protocols - Protocol tokens offered by the client.
 */
export function selectWsSubprotocol(protocols: Set<string>): string | undefined {
  for (const protocol of SUPPORTED_WS_PROTOCOLS) {
    if (protocols.has(protocol)) return protocol;
  }
  return protocols.values().next().value;
}

/**
 * Convenience wrapper for `handleConnection`: negotiate from the raw upgrade
 * request, defaulting to v1 when the request is missing entirely (unit tests
 * and older `ws` adapters call `handleConnection(client)` without a request).
 */
export function negotiateFromRequest(
  request?: Pick<IncomingMessage, "headers">,
): ProtocolNegotiation {
  return negotiateProtocol(request?.headers["sec-websocket-protocol"]);
}
