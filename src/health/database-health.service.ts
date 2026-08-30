import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** How long (ms) to wait for the DB probe before declaring it unreachable. */
const PROBE_TIMEOUT_MS = 3_000;

export interface DbHealthResult {
  /** "ok" when the database answered within the timeout, "unreachable" otherwise. */
  status: "ok" | "unreachable";
  /** Round-trip latency in milliseconds. Only present when status is "ok". */
  latencyMs?: number;
  /** Human-readable error message. Only present when status is "unreachable". */
  error?: string;
}

/**
 * Probes the PostgreSQL database with a lightweight `SELECT 1` query.
 *
 * - Uses `PrismaService.$queryRaw` so the probe exercises the real connection
 *   pool rather than a separate client.
 * - Races the query against a configurable timeout so a hung connection pool
 *   does not block the /health response indefinitely.
 * - Never throws — callers always receive a {@link DbHealthResult}.
 */
@Injectable()
export class DatabaseHealthService {
  private readonly logger = new Logger(DatabaseHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<DbHealthResult> {
    const start = Date.now();

    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        this.timeout(PROBE_TIMEOUT_MS),
      ]);

      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Database health probe failed: ${message}`);
      return { status: "unreachable", error: message };
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Database probe timed out after ${ms}ms`)), ms),
    );
  }
}
