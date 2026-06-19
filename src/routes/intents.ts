import { Router } from "express";
import { z } from "zod";
import { intentStore, solverStore } from "../services/intentService";
import { broadcast } from "../index";

export const intentsRouter = Router();

// ─── Validation schemas ───────────────────────────────────────────────────────

const createIntentSchema = z.object({
  user: z.string().min(10),
  srcChain: z.enum(["stellar", "ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"]),
  srcTokenAddress: z.string().min(10),
  srcTokenSymbol: z.string(),
  srcTokenDecimals: z.number().int().min(0).max(18),
  srcAmount: z.string().regex(/^\d+$/),
  dstTokenContract: z.string().min(10),
  dstTokenSymbol: z.string(),
  dstTokenDecimals: z.number().int().min(0).max(18),
  minDstAmount: z.string().regex(/^\d+$/),
  deadline: z.number().int().optional(),
});

const acceptIntentSchema = z.object({
  solver: z.string().min(5),
});

const fillIntentSchema = z.object({
  solver: z.string().min(5),
  fillAmount: z.string().regex(/^\d+$/),
  txHash: z.string().optional(),
});

// ─── GET /intents ─────────────────────────────────────────────────────────────

intentsRouter.get("/", (req, res) => {
  const { state, user, chain, limit = "20", offset = "0" } = req.query as Record<string, string>;
  let intents = intentStore.getAll();

  if (state)  intents = intents.filter(i => i.state === state);
  if (user)   intents = intents.filter(i => i.user.toLowerCase() === user.toLowerCase());
  if (chain)  intents = intents.filter(i => i.srcChain === chain);

  const l = Math.min(parseInt(limit), 100);
  const o = parseInt(offset);
  const page = intents.slice(o, o + l);

  res.json({
    intents: page,
    total: intents.length,
    limit: l,
    offset: o,
  });
});

// ─── GET /intents/open ────────────────────────────────────────────────────────

intentsRouter.get("/open", (_req, res) => {
  const open = intentStore.getByState("open");
  res.json({ intents: open, count: open.length });
});

// ─── GET /intents/:id ─────────────────────────────────────────────────────────

intentsRouter.get("/:id", (req, res) => {
  const intent = intentStore.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  res.json(intent);
});

// ─── POST /intents ────────────────────────────────────────────────────────────

intentsRouter.post("/", (req, res) => {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
  }

  const d = parsed.data;
  const now = Math.floor(Date.now() / 1000);

  const intent = intentStore.create({
    user: d.user,
    srcChain: d.srcChain,
    srcToken: {
      address: d.srcTokenAddress,
      symbol: d.srcTokenSymbol,
      name: d.srcTokenSymbol,
      decimals: d.srcTokenDecimals,
      chain: d.srcChain,
    },
    srcAmount: d.srcAmount,
    dstToken: {
      contract: d.dstTokenContract,
      symbol: d.dstTokenSymbol,
      decimals: d.dstTokenDecimals,
    },
    minDstAmount: d.minDstAmount,
    deadline: d.deadline ?? now + 1800,
  });

  broadcast({ type: "intent_created", intent });
  res.status(201).json(intent);
});

// ─── POST /intents/:id/accept ─────────────────────────────────────────────────

intentsRouter.post("/:id/accept", (req, res) => {
  const parsed = acceptIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
  }

  const intent = intentStore.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  if (intent.state !== "open") {
    return res.status(409).json({ error: `Intent is ${intent.state}, cannot accept` });
  }

  const now = Math.floor(Date.now() / 1000);
  if (intent.deadline <= now) {
    intentStore.update(req.params.id, { state: "expired" });
    return res.status(410).json({ error: "Intent has expired" });
  }

  const solver = solverStore.get(parsed.data.solver);
  if (!solver?.isActive) {
    return res.status(403).json({ error: "Solver not registered or inactive" });
  }

  const updated = intentStore.update(req.params.id, {
    state: "accepted",
    solver: parsed.data.solver,
    deadline: now + 300,   // 5-minute fill window
  });

  broadcast({ type: "intent_accepted", intentId: req.params.id, solver: parsed.data.solver });
  res.json(updated);
});

// ─── POST /intents/:id/fill ───────────────────────────────────────────────────

intentsRouter.post("/:id/fill", (req, res) => {
  const parsed = fillIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
  }

  const intent = intentStore.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  if (intent.state !== "accepted") {
    return res.status(409).json({ error: `Intent is ${intent.state}, cannot fill` });
  }
  if (intent.solver !== parsed.data.solver) {
    return res.status(403).json({ error: "Wrong solver for this intent" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (intent.deadline <= now) {
    return res.status(410).json({ error: "Fill window has expired" });
  }

  const fillAmount = BigInt(parsed.data.fillAmount);
  const minAmount = BigInt(intent.minDstAmount);
  if (fillAmount < minAmount) {
    return res.status(400).json({
      error: "Fill amount below minimum",
      fillAmount: parsed.data.fillAmount,
      minDstAmount: intent.minDstAmount,
    });
  }

  const updated = intentStore.update(req.params.id, {
    state: "filled",
    filledAt: now,
    fillAmount: parsed.data.fillAmount,
    txHash: parsed.data.txHash,
  });

  broadcast({
    type: "intent_filled",
    intentId: req.params.id,
    solver: parsed.data.solver,
    fillAmount: parsed.data.fillAmount,
  });

  res.json(updated);
});

// ─── POST /intents/:id/cancel ─────────────────────────────────────────────────

intentsRouter.post("/:id/cancel", (req, res) => {
  const { user } = req.body as { user?: string };
  const intent = intentStore.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  if (intent.user !== user) return res.status(403).json({ error: "Unauthorized" });
  if (!["open"].includes(intent.state)) {
    return res.status(409).json({ error: `Cannot cancel intent in state: ${intent.state}` });
  }

  const updated = intentStore.update(req.params.id, { state: "cancelled" });
  broadcast({ type: "intent_cancelled", intentId: req.params.id });
  res.json(updated);
});

// ─── GET /intents/user/:address ───────────────────────────────────────────────

intentsRouter.get("/user/:address", (req, res) => {
  const intents = intentStore.getByUser(req.params.address);
  res.json({ intents, count: intents.length });
});

// ─── POST /intents/quote ──────────────────────────────────────────────────────

intentsRouter.post("/quote", (req, res) => {
  const {
    srcChain, srcTokenSymbol, srcAmount, dstTokenSymbol
  } = req.body as {
    srcChain: string;
    srcTokenSymbol: string;
    srcAmount: string;
    dstTokenSymbol: string;
  };

  if (!srcChain || !srcTokenSymbol || !srcAmount || !dstTokenSymbol) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Simulate a quote from available solvers
  const solvers = solverStore.getAll().filter(s => s.isActive);
  const quotes = solvers.map(solver => {
    // Each solver offers slightly different rates
    const variance = 1 - Math.random() * 0.008; // 0-0.8% variance
    const dstAmount = Math.floor(Number(srcAmount) * variance);
    const fee = Math.floor(dstAmount * 0.0005); // 0.05%
    return {
      solver: solver.address,
      solverName: solver.name,
      dstAmount: dstAmount.toString(),
      fee: fee.toString(),
      fillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
  }).sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

  res.json({
    quotes,
    bestQuote: quotes[0] ?? null,
    srcChain,
    srcTokenSymbol,
    srcAmount,
    dstTokenSymbol,
    estimatedFillTime: quotes[0]?.fillTime ?? 0,
  });
});
