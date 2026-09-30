/**
 * AUTO-GENERATED — do not edit by hand.
 * Regenerate with: npm run generate:ws-types
 *
 * Source: docs/asyncapi.yaml (served live at GET /docs/ws).
 *
 * Usage:
 *   import type { WsServerFrame, IntentCreated } from './generated/ws-api-types';
 *
 * Issue #456
 */

export interface Connected {
  type: "connected";
  /**
   * Human-readable greeting.
   */
  message: string;
  /**
   * Last sequence number already assigned (0 when nothing has been broadcast).
   */
  seq: number;
  /**
   * Negotiated subprotocol version (defaults to v1 when the client offered none).
   */
  protocol: "vortex.v1";
}

export interface Snapshot {
  type: "snapshot";
  intents: Intent[];
  seq: number;
}

export interface Subscribed {
  type: "subscribed";
  filter: SubscribedFilter;
}

/**
 * Either `{ "all": true }` (unfiltered feed) or the chain filter that was
 * installed, containing only chains the protocol recognises.
 */
export interface SubscribedFilter {
  all?: boolean;
  chains?: SupportedChain[];
}

export interface SubscribeRejected {
  type: "subscribe_rejected";
  reason: string;
}

export interface ReplayStart {
  type: "replay_start";
  /**
   * Cursor the client asked for.
   */
  fromSeq: number;
  /**
   * Number of event frames that follow before `replay_end`.
   */
  count: number;
}

export interface ReplayEnd {
  type: "replay_end";
  count: number;
}

export interface ReplayTooOld {
  type: "replay_too_old";
  fromSeq: number;
  /**
   * Oldest seq still retained — retry from `oldestAvailableSeq - 1` or take a new snapshot.
   */
  oldestAvailableSeq: number;
}

export interface AuthOk {
  type: "auth_ok";
}

export interface AuthError {
  type: "auth_error";
  reason: "auth payload requires solver, timestamp, and signature" | "stale or future auth timestamp" | "solver not registered or inactive" | "invalid solver signature";
}

export interface EligibleSnapshot {
  type: "eligible_snapshot";
  intents: Intent[];
  count: number;
}

export interface IntentCreated {
  type: "intent_created";
  seq: number;
  intent: Intent;
}

export interface IntentAccepted {
  type: "intent_accepted";
  seq: number;
  intentId: string;
  /**
   * Stellar public key of the accepting solver.
   */
  solver: string;
}

export interface IntentFilled {
  type: "intent_filled";
  seq: number;
  intentId: string;
  solver: string;
  /**
   * Filled amount in destination-token base units.
   */
  fillAmount: string;
}

export interface IntentCancelled {
  type: "intent_cancelled";
  seq: number;
  intentId: string;
}

export interface IntentExpired {
  type: "intent_expired";
  seq: number;
  intentId: string;
}

export interface IntentSlashed {
  type: "intent_slashed";
  seq: number;
  intentId: string;
  /**
   * Slashed solver address; null/absent when the accepted intent had no solver on record.
   */
  solver?: string | null;
  reason: string;
}

export interface ProtocolStatus {
  type: "protocol_status";
  seq: number;
  action: "paused" | "resumed";
  scope: "global" | "chain" | "token" | "operation";
  chain: string | null;
  token: string | null;
  operation: string | null;
  reasonCode: string;
  reason: string;
  /**
   * True when the switch is active after this change.
   */
  paused: boolean;
}

export interface SubscribeMessage {
  type: "subscribe";
  /**
   * Chain names to keep; values the protocol does not recognise are dropped.
   */
  chains?: string[];
  /**
   * Opt out of capability filtering and receive the full feed.
   */
  all?: boolean;
}

export interface ReplayMessage {
  type: "replay";
  /**
   * Highest sequence number the client has already processed.
   */
  fromSeq: number;
}

export interface AuthMessage {
  type: "auth";
  /**
   * Stellar public key of the solver.
   */
  solver: string;
  /**
   * Unix seconds; must be within 300 s of server time.
   */
  timestamp: number;
  /**
   * Base64 ed25519 signature over the WS auth message.
   */
  signature: string;
}

export type SupportedChain = "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";

/**
 * An intent as it appears on the feed (REST `GET /api/v1/intents/:id`
 * returns the same shape). Additional keys may appear as the payload
 * evolves; clients must ignore unknown fields.
 */
export interface Intent {
  intentId: string;
  /**
   * User address that created the intent.
   */
  user: string;
  srcChain: SupportedChain;
  srcToken: TokenInfo;
  /**
   * Source amount in base units (bigint as string).
   */
  srcAmount: string;
  dstToken: StellarToken;
  minDstAmount: string;
  quotedDstAmount?: string;
  /**
   * Solver that accepted the intent (absent while open).
   */
  solver?: string;
  state: "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed";
  /**
   * Unix seconds.
   */
  createdAt: number;
  /**
   * Unix seconds.
   */
  deadline: number;
  filledAt?: number;
  fillAmount?: string;
  feeAmount?: string;
  txHash?: string;
  slashedAt?: number;
  slashReason?: string;
  /**
   * Governance parameter snapshot version active at creation.
   */
  paramsVersion?: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoURI?: string;
  priceUSD?: number;
}

export interface StellarToken {
  contract: string;
  symbol: string;
  decimals: number;
  priceUSD?: number;
}

/** Every frame the gateway may send to a client. */
export type WsServerFrame =
  | Connected
  | Snapshot
  | Subscribed
  | SubscribeRejected
  | ReplayStart
  | ReplayEnd
  | ReplayTooOld
  | AuthOk
  | AuthError
  | EligibleSnapshot
  | IntentCreated
  | IntentAccepted
  | IntentFilled
  | IntentCancelled
  | IntentExpired
  | IntentSlashed
  | ProtocolStatus;

/** Every message a client may send to the gateway. */
export type WsClientMessage =
  | SubscribeMessage
  | ReplayMessage
  | AuthMessage;

