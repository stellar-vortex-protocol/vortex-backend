// Reference solver bot - see scripts/README.md.
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAcceptMessage, buildFillMessage } from "../src/common/stellar-signature";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WS_URL = process.env.WS_URL ?? "ws://localhost:4000/ws";

// The bot requires a Stellar secret key (S...) to sign requests.
// Set SOLVER_SECRET to the solver keypair's secret key.
// The derived public key (G...) is used as the solver address.
const SOLVER_SECRET = process.env.SOLVER_SECRET;
if (!SOLVER_SECRET) {
  console.error("[solver-bot] SOLVER_SECRET env var is required (Stellar secret key S...)");
  process.exit(1);
}

const keypair = Keypair.fromSecret(SOLVER_SECRET);
const SOLVER_ADDRESS = keypair.publicKey();

console.log(`[solver-bot] solver address: ${SOLVER_ADDRESS}`);

interface Intent {
  intentId: string;
  state: string;
  minDstAmount: string;
  deadline: number;
}

/** Sign a UTF-8 message with the solver keypair; return base64 signature. */
function sign(message: string): string {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
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

  const accepted = await acceptIntent(intent.intentId);
  if (!accepted) return;

  await fillIntent(intent.intentId, intent.minDstAmount);
}

function main() {
  console.log(`[solver-bot] connecting as ${SOLVER_ADDRESS} to ${WS_URL}`);
  const ws = new WebSocket(WS_URL);

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());

    switch (event.type) {
      case "connected":
        console.log(`[solver-bot] ${event.message}`);
        break;
      case "snapshot":
        console.log(`[solver-bot] snapshot: ${event.intents.length} open intent(s)`);
        for (const intent of event.intents as Intent[]) {
          void tryFillOpenIntent(intent);
        }
        break;
      case "intent_created":
        console.log(`[solver-bot] new intent ${event.intent.intentId}`);
        void tryFillOpenIntent(event.intent as Intent);
        break;
      case "intent_accepted":
      case "intent_filled":
      case "intent_cancelled":
      case "intent_expired":
        console.log(`[solver-bot] ${event.type}: ${event.intentId}`);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => console.log("[solver-bot] disconnected"));
  ws.on("error", (err) => console.error("[solver-bot] error", err));
}

main();
