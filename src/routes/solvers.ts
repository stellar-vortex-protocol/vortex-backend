import { Router } from "express";
import { solverStore } from "../services/intentService";

export const solversRouter = Router();

solversRouter.get("/", (_req, res) => {
  const solvers = solverStore.getAll().sort((a, b) => b.fillsCompleted - a.fillsCompleted);
  res.json({ solvers, count: solvers.length });
});

solversRouter.get("/:address", (req, res) => {
  const solver = solverStore.get(req.params.address);
  if (!solver) return res.status(404).json({ error: "Solver not found" });
  res.json(solver);
});

solversRouter.get("/:address/stats", (req, res) => {
  const solver = solverStore.get(req.params.address);
  if (!solver) return res.status(404).json({ error: "Solver not found" });

  const total = solver.fillsCompleted + solver.fillsFailed;
  const successRate = total > 0 ? solver.fillsCompleted / total : 0;

  res.json({
    address: solver.address,
    name: solver.name,
    fillsCompleted: solver.fillsCompleted,
    fillsFailed: solver.fillsFailed,
    successRate: parseFloat(successRate.toFixed(4)),
    totalVolume: solver.totalVolume,
    avgFillTime: solver.avgFillTime,
    bondAmount: solver.bondAmount,
  });
});
