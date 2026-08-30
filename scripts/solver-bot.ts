// Reference solver bot - see scripts/README.md.
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAcceptMessage, buildFillMessage } from "../src/common/stellar-signature";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WS_URL = process.env.WS_URL ?? "ws://localhost:4000/ws";
const SOLVER_ADDRESS = process.env.SOLVER_ADDRESS ?? "SOLVER_ALPHA";
const MIN_MARGIN_BPS = Number(process.env.MIN_MARGIN_BPS ?? "0");
const SOLVER_CHAINS = (process.env.SOLVER_CHAINS ?? "stellar,ethereum,base,polygon,arbitrum,optimism,avalanche").split(",");

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_FACTOR = 2;

/**
 * Issue #121: WS authentication for solver connections.
 * Load the solver keypair from SOLVER_SECRET env var so the bot can prove
 * its identity to the server via a signed auth message.
 */
const SOLVER_SECRET = process.env.SOLVER_SECRET ?? "";
const keypair: Keypair | null = SOLVER_SECRET ? Keypair.fromSecret(SOLVER_SECRET) : null;

let lastSeq = 0;
let shouldReconnect = true;

interface Intent {
  intentId: string;
  state: string;
  minDstAmount: string;
  deadline: number;
  srcChain: string;
}

interface SequencedMessage {
  type: string;
  seq?: number;
  [key: string]: unknown;
}

/** Sign a UTF-8 message with the solver keypair; return base64 signature. */
function sign(message: string): string {
  if (!keypair) throw new Error("SOLVER_SECRET is not set — cannot sign messages");
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

/**
 * Issue #121: Send a signed auth message to identify this bot as a solver.
 * The message format mirrors REST endpoint signatures: `solver-auth:<address>:<timestamp>`.
 * The timestamp prevents replay attacks; the server validates the signature
 * against the registered solver's public key.
 */
function sendAuth(ws: WebSocket): void {
  if (!keypair) {
    console.warn("[solver-bot] SOLVER_SECRET not set — connecting as anonymous read-only client");
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `solver-auth:${SOLVER_ADDRESS}:${timestamp}`;
  const signature = sign(message);
  ws.send(JSON.stringify({ type: "auth", solver: SOLVER_ADDRESS, timestamp, signature }));
  console.log(`[solver-bot] sent auth for ${SOLVER_ADDRESS}`);
}

async function acceptIntent(intentId: string): Promise<boolean> {
  const message = buildAcceptMessage(intentId, SOLVER_ADDRESS);
  const signature = sign(message);

  const res = await fetch(`${API_BASE}/api/v1/intents/${intentId}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ solver: SOLVER_ADDRESS, signature }),
  });
  if (!res.ok) {
    console.log(`[solver-bot] accept ${intentId} failed: ${res.status} ${await res.text()}`);
    return false;
  }
  console.log(`[solver-bot] accepted ${intentId}`);
  return true;
}

async function fillIntent(intentId: string, minDstAmount: string): Promise<void> {
  const message = buildFillMessage(intentId, SOLVER_ADDRESS);
  const signature = sign(message);

  const res = await fetch(`${API_BASE}/api/v1/intents/${intentId}/fill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      solver: SOLVER_ADDRESS,
      fillAmount: minDstAmount,
      txHash: `demo-${Date.now()}`,
      signature,
    }),
  });
  if (!res.ok) {
    console.log(`[solver-bot] fill ${intentId} failed: ${res.status} ${await res.text()}`);
    return;
  }
  console.log(`[solver-bot] filled ${intentId}`);
}

async function tryFillOpenIntent(intent: Intent): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (intent.state !== "open" || intent.deadline <= now) return;
  if (!SOLVER_CHAINS.includes(intent.srcChain)) {
    console.log(`[solver-bot] skipping ${intent.intentId} on ${intent.srcChain} (not subscribed)`);
    return;
  }

  if (MIN_MARGIN_BPS > 0 && Number(intent.minDstAmount) < 1_000_000 * (MIN_MARGIN_BPS / 10000)) {
    console.log(`[solver-bot] skipped ${intent.intentId} below min margin ${MIN_MARGIN_BPS} bps`);
    return;
  }

  const accepted = await acceptIntent(intent.intentId);
  if (!accepted) return;
  await fillIntent(intent.intentId, intent.minDstAmount);
}

function connectWithBackoff(delayMs: number): void {
  if (!shouldReconnect) return;

  console.log(
    `[solver-bot] connecting as ${SOLVER_ADDRESS} to ${WS_URL}` +
      (delayMs > BACKOFF_INITIAL_MS ? ` (reconnect delay ${delayMs}ms)` : ""),
  );

  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    // Issue #121: authenticate the solver connection immediately on open.
    sendAuth(ws);

    // If we have a previous seq, request a replay of missed events.
    if (lastSeq > 0) {
      console.log(`[solver-bot] requesting replay from seq=${lastSeq}`);
      ws.send(JSON.stringify({ type: "replay", fromSeq: lastSeq }));
    }

    ws.send(JSON.stringify({ type: "subscribe", chains: SOLVER_CHAINS }));
  });

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as SequencedMessage;

    if (typeof event.seq === "number" && event.seq > lastSeq) {
      lastSeq = event.seq;
    }

    switch (event.type) {
      case "connected":
        console.log(`[solver-bot] ${event.message as string}`);
        break;

      case "auth_ok":
        console.log(`[solver-bot] authenticated as solver ${SOLVER_ADDRESS}`);
        break;

      case "auth_error":
        console.error(`[solver-bot] auth rejected: ${event.reason as string}`);
        break;

      case "subscribed":
        console.log(`[solver-bot] subscribed with filter: ${JSON.stringify(event.filter)}`);
        break;

      case "snapshot":
        console.log(`[solver-bot] snapshot: ${(event.intents as Intent[]).length} open intent(s) seq=${event.seq ?? 0}`);
        for (const intent of event.intents as Intent[]) {
          void tryFillOpenIntent(intent);
        }
        break;

      case "replay_start":
        console.log(`[solver-bot] replay: expecting ${event.count as number} missed event(s) from seq=${event.fromSeq as number}`);
        break;

      case "replay_end":
        console.log(`[solver-bot] replay complete: ${event.count as number} event(s) replayed`);
        break;

      case "replay_too_old":
        console.warn(
          `[solver-bot] replay gap too large (fromSeq=${event.fromSeq as number}, ` +
            `oldest available=${event.oldestAvailableSeq as number}). Falling back to snapshot.`,
        );
        lastSeq = 0;
        break;

      case "intent_created":
        console.log(`[solver-bot] new intent ${(event.intent as Intent).intentId} on ${(event.intent as Intent).srcChain}`);
        void tryFillOpenIntent(event.intent as Intent);
        break;

      case "intent_accepted":
      case "intent_filled":
      case "intent_cancelled":
      case "intent_expired":
        console.log(`[solver-bot] ${event.type}: ${event.intentId as string} seq=${event.seq ?? "?"}`);
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    console.log(`[solver-bot] disconnected (lastSeq=${lastSeq})`);
    const nextDelay = Math.min(delayMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    setTimeout(() => connectWithBackoff(nextDelay), delayMs);
  });

  ws.on("error", (err) => {
    console.error(`[solver-bot] error`, err);
    ws.close();
  });
}

function main() {
  console.log(`[solver-bot] subscribed chains: ${SOLVER_CHAINS.join(", ")}`);
  if (!keypair) {
    console.warn("[solver-bot] SOLVER_SECRET not set — running in anonymous read-only mode");
  }

  process.on("SIGINT", () => {
    shouldReconnect = false;
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    shouldReconnect = false;
    process.exit(0);
  });

  connectWithBackoff(BACKOFF_INITIAL_MS);
}

main();
