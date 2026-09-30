import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  DB_QUERY_TIMEOUT_MS,
  DB_BATCH_QUERY_TIMEOUT_MS,
  DB_STATS_QUERY_TIMEOUT_MS,
} from "../config/limits.config";

/**
 * PrismaService wraps PrismaClient and participates in the NestJS lifecycle.
 *
 * - Connects on module init so the connection pool is warm at startup.
 * - Disconnects on module destroy for clean shutdown (important in tests).
 *
 * Issue #476 — statement_timeout helpers
 * ──────────────────────────────────────
 * Postgres `statement_timeout` provides a last-resort guard against
 * expensive queries triggered by pathological inputs (large offset values,
 * missing indexes after a migration, etc.).  It fires entirely at the DB
 * level so even queries that bypass the application layer are covered.
 *
 * Usage:
 *   // In a repository or service method:
 *   await this.prisma.withTimeout(DB_QUERY_TIMEOUT_MS, async (tx) => {
 *     return tx.intent.findMany(...);
 *   });
 *
 * The helpers are intentionally opt-in (not a global Prisma middleware) so
 * that long-running migrations and background jobs can choose their own
 * appropriate timeout.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Prisma connected to database");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Prisma disconnected from database");
  }

  /**
   * Execute `fn` inside a transaction with a Postgres `statement_timeout`
   * set to `timeoutMs`.  The timeout resets automatically when the
   * transaction commits or rolls back.
   *
   * @param timeoutMs - Timeout in milliseconds (e.g. DB_QUERY_TIMEOUT_MS).
   * @param fn        - Callback that receives a transactional Prisma client.
   *
   * @example
   * const results = await this.prisma.withTimeout(DB_QUERY_TIMEOUT_MS, (tx) =>
   *   tx.intent.findMany({ where: { state: "open" }, take: 100 }),
   * );
   */
  async withTimeout<T>(
    timeoutMs: number,
    fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return fn(tx);
    });
  }

  /**
   * Standard query timeout — use for simple indexed lookups.
   * Default: DB_QUERY_TIMEOUT_MS (5 000 ms from limits.config.ts).
   */
  async withDefaultTimeout<T>(
    fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>,
  ): Promise<T> {
    const ms = parseInt(process.env.DB_QUERY_TIMEOUT_MS ?? String(DB_QUERY_TIMEOUT_MS), 10);
    return this.withTimeout(ms, fn);
  }

  /**
   * Batch query timeout — use for endpoints that fan out across multiple rows.
   * Default: DB_BATCH_QUERY_TIMEOUT_MS (10 000 ms from limits.config.ts).
   */
  async withBatchTimeout<T>(
    fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>,
  ): Promise<T> {
    const ms = parseInt(process.env.DB_BATCH_QUERY_TIMEOUT_MS ?? String(DB_BATCH_QUERY_TIMEOUT_MS), 10);
    return this.withTimeout(ms, fn);
  }

  /**
   * Stats/aggregate query timeout — use for leaderboard and aggregate queries
   * that may scan larger index ranges.
   * Default: DB_STATS_QUERY_TIMEOUT_MS (15 000 ms from limits.config.ts).
   */
  async withStatsTimeout<T>(
    fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>,
  ): Promise<T> {
    const ms = parseInt(process.env.DB_STATS_QUERY_TIMEOUT_MS ?? String(DB_STATS_QUERY_TIMEOUT_MS), 10);
    return this.withTimeout(ms, fn);
  }
}
