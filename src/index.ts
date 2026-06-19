import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { intentsRouter } from "./routes/intents";
import { solversRouter } from "./routes/solvers";
import { tokensRouter } from "./routes/tokens";
import { intentStore, solverStore } from "./services/intentService";

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use("/api/v1/intents", intentsRouter);
app.use("/api/v1/solvers", solversRouter);
app.use("/api/v1/tokens", tokensRouter);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "vortex-backend",
    version: "0.1.0",
    network: "stellar-testnet",
    uptime: process.uptime(),
  });
});

app.get("/api/v1/stats", (_req, res) => {
  const intents = intentStore.getAll();
  const solvers = solverStore.getAll();

  const open   = intents.filter(i => i.state === "open").length;
  const filled = intents.filter(i => i.state === "filled");
  const totalVol = filled.reduce((s, i) => s + BigInt(i.fillAmount ?? "0"), 0n);

  const fillTimes = filled
    .filter(i => i.filledAt != null)
    .map(i => i.filledAt! - i.createdAt);
  const avgFillTime = fillTimes.length
    ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
    : 0;

  res.json({
    totalIntents: intents.length,
    openIntents: open,
    totalVolume: totalVol.toString(),
    uniqueUsers: new Set(intents.map(i => i.user)).size,
    activeSolvers: solvers.filter(s => s.isActive).length,
    avgFillTime: Math.round(avgFillTime),
    fillRate: intents.length ? filled.length / intents.length : 0,
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── WebSocket — real-time intent feed ────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const subscribers = new Set<WebSocket>();

wss.on("connection", (ws) => {
  subscribers.add(ws);
  ws.send(JSON.stringify({ type: "connected", message: "Vortex intent stream" }));

  // Send current open intents on connect
  const open = intentStore.getByState("open").slice(0, 20);
  ws.send(JSON.stringify({ type: "snapshot", intents: open }));

  ws.on("close", () => subscribers.delete(ws));
  ws.on("error", () => subscribers.delete(ws));
});

export function broadcast(event: { type: string; [k: string]: unknown }) {
  const payload = JSON.stringify(event);
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ─── Intent expiry sweeper (runs every 30s) ───────────────────────────────────

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let expiredCount = 0;

  for (const intent of intentStore.getByState("open")) {
    if (intent.deadline <= now) {
      intentStore.update(intent.intentId, { state: "expired" });
      expiredCount++;
      broadcast({ type: "intent_expired", intentId: intent.intentId });
    }
  }

  if (expiredCount > 0) {
    console.log(`[sweeper] Expired ${expiredCount} intent(s)`);
  }
}, 30_000);

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
httpServer.listen(PORT, () => {
  console.log(`\nVortex backend running on :${PORT}`);
  console.log(`REST  → http://localhost:${PORT}/api/v1`);
  console.log(`WS    → ws://localhost:${PORT}/ws`);
  console.log(`Stats → http://localhost:${PORT}/api/v1/stats\n`);
});
