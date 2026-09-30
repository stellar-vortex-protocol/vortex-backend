/**
 * Minimal solver built on @vortex/solver-sdk: authenticates over WS, accepts
 * every new intent it is offered, and fills it.
 *
 *   SOLVER_SECRET=S... API_BASE=http://localhost:4000 npx tsx packages/solver-sdk/examples/example-solver.ts
 *
 * Real solvers price the intent and settle on-chain before calling fill; the
 * txHash here is a placeholder.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { signAccept, signFill, signWsAuth, VortexRestClient, VortexWsClient } from "../src";

const apiBase = process.env.API_BASE ?? "http://localhost:4000";
const keypair = Keypair.fromSecret(process.env.SOLVER_SECRET ?? "");
const rest = new VortexRestClient(apiBase);
const ws = new VortexWsClient({
  url: `${apiBase.replace(/^http/, "ws")}/ws`,
  signAuth: () => signWsAuth(keypair),
});

ws.on("auth_ok", () => console.log(`authenticated as ${keypair.publicKey()}`));
ws.on("resync_required", async () => {
  // The gap is older than the server's replay buffer: rebuild state over REST.
  const { intents } = await rest.listOpenIntents();
  console.log(`resynced ${intents.length} open intents`);
});
ws.on("event", async (event) => {
  if (event.type !== "intent_created" || !event.intent) return;
  const intent = event.intent as { intentId: string; minDstAmount: string };
  try {
    await rest.accept(intent.intentId, signAccept(keypair, intent.intentId, { network: "testnet" }));
    await rest.fill(
      intent.intentId,
      signFill(keypair, intent.intentId, intent.minDstAmount, `example-${Date.now()}`, { network: "testnet" }),
    );
    console.log(`filled ${intent.intentId} (seq ${event.seq})`);
  } catch (err) {
    console.error(`intent ${intent.intentId}: ${(err as Error).message}`);
  }
});
ws.connect();
