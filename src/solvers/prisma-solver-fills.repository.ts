import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { FillAggregateQuery, ISolverFillsRepository } from "./solver-fills.repository";
import { SolverFillAggregate, SolverFillRecord } from "./solver-fills.types";

/** PrismaService, or the client handed to a `$transaction` callback. */
export type SolverFillsPrismaClient = PrismaService | Prisma.TransactionClient;

/**
 * Raw aggregate row. Postgres returns BIGINT counts as `bigint` and NUMERIC
 * values as Prisma `Decimal`, so both are normalised by {@link mapAggregateRow}.
 */
export interface SolverFillAggregateRow {
  solver: string;
  fills_completed: bigint | number;
  fills_failed: bigint | number;
  total_volume: Prisma.Decimal | string | null;
  total_volume_usd: Prisma.Decimal | string | null;
  avg_fill_seconds: Prisma.Decimal | string | number | null;
  p50_fill_seconds: number | null;
  p95_fill_seconds: number | null;
}

/** Exact decimal string for a NUMERIC that may arrive as text or as a Decimal. */
function decimalString(value: Prisma.Decimal | string | null, scale = 0): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.toFixed(scale);
}

/** Typed mapper shared by the windowed query and `mv_solver_leaderboard`. */
export function mapAggregateRow(row: SolverFillAggregateRow): SolverFillAggregate {
  const avg = row.avg_fill_seconds === null ? null : Number(row.avg_fill_seconds.toString());
  return {
    solver: row.solver,
    fillsCompleted: Number(row.fills_completed),
    fillsFailed: Number(row.fills_failed),
    totalVolume: decimalString(row.total_volume) ?? "0",
    totalVolumeUsd: decimalString(row.total_volume_usd, 8),
    avgFillTime: avg === null ? 0 : Math.round(avg),
    p50FillTime: row.p50_fill_seconds === null ? null : Number(row.p50_fill_seconds),
    p95FillTime: row.p95_fill_seconds === null ? null : Number(row.p95_fill_seconds),
  };
}

/**
 * Aggregate expression list — identical in the windowed query and in the
 * `mv_solver_leaderboard` definition (20261020000002_stats_materialized_views).
 */
const AGGREGATE_COLUMNS = Prisma.sql`
  "solver",
  count(*) FILTER (WHERE "outcome" = 'filled')::BIGINT AS "fills_completed",
  GREATEST(count(*) FILTER (WHERE "outcome" = 'failed')
    - count(*) FILTER (WHERE "outcome" = 'reversed'), 0)::BIGINT AS "fills_failed",
  COALESCE(sum("dst_amount") FILTER (WHERE "outcome" = 'filled'), 0) AS "total_volume",
  sum("usd_value") FILTER (WHERE "outcome" = 'filled') AS "total_volume_usd",
  avg("fill_seconds") FILTER (WHERE "outcome" = 'filled') AS "avg_fill_seconds",
  percentile_disc(0.5) WITHIN GROUP (ORDER BY "fill_seconds")
    FILTER (WHERE "outcome" = 'filled' AND "fill_seconds" IS NOT NULL) AS "p50_fill_seconds",
  percentile_disc(0.95) WITHIN GROUP (ORDER BY "fill_seconds")
    FILTER (WHERE "outcome" = 'filled' AND "fill_seconds" IS NOT NULL) AS "p95_fill_seconds"`;

/**
 * Outer projection over {@link AGGREGATE_COLUMNS} or `mv_solver_leaderboard`:
 * NUMERIC columns leave Postgres as exact text, never through a float or a
 * precision-limited Decimal.
 */
export const AGGREGATE_TEXT_PROJECTION = Prisma.sql`
  "solver", "fills_completed", "fills_failed",
  "total_volume"::TEXT AS "total_volume",
  "total_volume_usd"::TEXT AS "total_volume_usd",
  "avg_fill_seconds"::TEXT AS "avg_fill_seconds",
  "p50_fill_seconds", "p95_fill_seconds"`;

/**
 * Postgres adapter for `solver_fills` (issue #417).
 *
 * Constructed with either the root client or a transaction client, so the
 * fill/failure transition and its row commit together (see
 * {@link FillLedgerUnitOfWork}). Windowed reads use the
 * `(solver, created_at)` / `(created_at)` indexes — a range scan over the
 * window, never a full-table aggregate.
 */
export class PrismaSolverFillsRepository implements ISolverFillsRepository {
  constructor(private readonly prisma: SolverFillsPrismaClient) {}

  async record(fill: SolverFillRecord): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "solver_fills"
        ("intent_id", "solver", "chain", "src_amount", "dst_amount", "usd_value",
         "fill_seconds", "outcome", "ledger", "created_at")
      VALUES (
        ${fill.intentId}, ${fill.solver}, ${fill.chain}::"SupportedChain",
        ${fill.srcAmount}::NUMERIC, ${fill.dstAmount}::NUMERIC, ${fill.usdValue}::NUMERIC,
        ${fill.fillSeconds}::INTEGER, ${fill.outcome}::"solver_fill_outcome", ${fill.ledger}::INTEGER,
        to_timestamp(${fill.createdAt}::BIGINT)
      )
      ON CONFLICT ("intent_id", "outcome") DO NOTHING`;
  }

  async aggregate(query: FillAggregateQuery): Promise<SolverFillAggregate[]> {
    const where: Prisma.Sql[] = [];
    if (query.solver !== undefined) where.push(Prisma.sql`"solver" = ${query.solver}`);
    if (query.since !== undefined) where.push(Prisma.sql`"created_at" >= to_timestamp(${query.since}::BIGINT)`);
    const filter = where.length ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<SolverFillAggregateRow[]>`
      SELECT ${AGGREGATE_TEXT_PROJECTION}
      FROM (
        SELECT ${AGGREGATE_COLUMNS}
        FROM "solver_fills"
        ${filter}
        GROUP BY "solver"
      ) agg
      ORDER BY "solver" COLLATE "C"`;
    return rows.map(mapAggregateRow);
  }

  async findBySolver(solver: string): Promise<SolverFillRecord[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        intent_id: string;
        solver: string;
        chain: string;
        src_amount: string;
        dst_amount: string | null;
        usd_value: string | null;
        fill_seconds: number | null;
        outcome: "filled" | "failed" | "reversed";
        ledger: number | null;
        created_at: bigint | number;
      }>
    >`
      SELECT "intent_id", "solver", "chain"::TEXT AS "chain",
             "src_amount"::TEXT AS "src_amount", "dst_amount"::TEXT AS "dst_amount",
             "usd_value"::TEXT AS "usd_value", "fill_seconds", "outcome"::TEXT AS "outcome",
             "ledger", extract(epoch FROM "created_at")::BIGINT AS "created_at"
      FROM "solver_fills"
      WHERE "solver" = ${solver}
      ORDER BY "created_at", "id"`;
    return rows.map((r) => ({
      intentId: r.intent_id,
      solver: r.solver,
      chain: r.chain as SolverFillRecord["chain"],
      srcAmount: r.src_amount,
      dstAmount: r.dst_amount,
      usdValue: r.usd_value,
      fillSeconds: r.fill_seconds,
      outcome: r.outcome,
      ledger: r.ledger,
      createdAt: Number(r.created_at),
    }));
  }
}
