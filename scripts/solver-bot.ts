// Reference solver bot - see scripts/README.md.
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAcceptMessage, buildFillMessage } from "../src/common/stellar-signature";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WS_URL = process.env.WS_URL ?? "ws://localhost:4000/ws";
const SOLVER_ADDRESS = process.env.SOLVER_ADDRESS ?? "SOLVER_ALPHA";
const SOLVER_CHAINS = (process.env.SOLVER_CHAINS ?? "stellar,ethereum,base,polygon,arbitrum,optimism,avalanche").split(",");

interface Intent {
  intentId: string;
  state: string;
  minDstAmount: string;
  deadline: number;
  srcChain: string;
}

/** Sign a UTF-8 message with the solver keypair; return base64 signature. */
function sign(message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

interface SequencedMessage {
  type: string;
  seq?: number;
  [key: string]: unknown;
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

  const accepted = await acceptIntent(intent.intentId);
  if (!accepted) return;

  await fillIntent(intent.intentId, intent.minDstAmount);
}

function main() {
  console.log(`[solver-bot] connecting as ${SOLVER_ADDRESS} to ${WS_URL}`);
  console.log(`[solver-bot] subscribed chains: ${SOLVER_CHAINS.join(", ")}`);
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    // If we have a previous seq, ask the server to replay missed events before
    // falling through to the normal snapshot flow.
    if (lastSeq > 0) {
      console.log(`[solver-bot] requesting replay from seq=${lastSeq}`);
      ws.send(JSON.stringify({ event: "replay", data: { fromSeq: lastSeq } }));
    }
  });

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as SequencedMessage;

    // Track the highest sequence number we've seen
    if (typeof event.seq === "number" && event.seq > lastSeq) {
      lastSeq = event.seq;
    }

    switch (event.type) {
      case "connected":
        console.log(`[solver-bot] ${event.message}`);
        ws.send(JSON.stringify({ type: "subscribe", chains: SOLVER_CHAINS }));
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
        // Our cursor is stale; the server will send a fresh snapshot automatically
        // on next connection — nothing extra needed.
        console.warn(
          `[solver-bot] replay gap too large (fromSeq=${event.fromSeq as number}, ` +
            `oldest available=${event.oldestAvailableSeq as number}). Falling back to snapshot.`,
        );
        lastSeq = 0;
        break;

      case "intent_created":
        console.log(`[solver-bot] new intent ${event.intent.intentId} on ${event.intent.srcChain}`);
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
    console.log(`[solver-bot] disconnected (lastSeq=${lastSeq}). Reconnecting in ${RECONNECT_DELAY_MS}ms…`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => console.error("[solver-bot] error", err));
}

connect();
