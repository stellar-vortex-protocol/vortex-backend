// Reference solver bot - see scripts/README.md.
import WebSocket from "ws";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WS_URL = process.env.WS_URL ?? "ws://localhost:4000/ws";
const SOLVER_ADDRESS = process.env.SOLVER_ADDRESS ?? "SOLVER_ALPHA";

interface Intent {
  intentId: string;
  state: string;
  minDstAmount: string;
  deadline: number;
}

async function acceptIntent(intentId: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/v1/intents/${intentId}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ solver: SOLVER_ADDRESS }),
  });
  if (!res.ok) {
    console.log(`[solver-bot] accept ${intentId} failed: ${res.status} ${await res.text()}`);
    return false;
  }
  console.log(`[solver-bot] accepted ${intentId}`);
  return true;
}

async function fillIntent(intentId: string, minDstAmount: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/intents/${intentId}/fill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      solver: SOLVER_ADDRESS,
      fillAmount: minDstAmount,
      txHash: `demo-${Date.now()}`,
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
