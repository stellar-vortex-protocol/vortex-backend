import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { DatabaseHealthService } from "./database-health.service";
import { HealthIndicator, IndicatorResult, ServiceRole } from "./health-indicator.registry";

/** True when any repository adapter persists to Postgres, making the DB critical. */
export function databaseIsCritical(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["INTENTS_PERSISTENCE", "SOLVERS_PERSISTENCE", "KILLSWITCH_PERSISTENCE"].some((k) => env[k] === "prisma");
}

export function databaseIndicator(db: DatabaseHealthService, critical: boolean): HealthIndicator {
  return {
    name: "database",
    criticalFor: critical ? ["api", "worker"] : [],
    async check() {
      const r = await db.check();
      return r.status === "ok"
        ? { status: "up", details: { latencyMs: r.latencyMs } }
        : { status: "down", error: r.error };
    },
  };
}

/**
 * Startup check: every migration directory shipped with the build is recorded
 * as applied in `_prisma_migrations`.
 */
export function migrationsIndicator(
  prisma: PrismaService,
  migrationsDir = join(process.cwd(), "prisma", "migrations"),
): HealthIndicator {
  return {
    name: "migrations",
    criticalFor: [],
    startup: true,
    async check() {
      const expected = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const applied = new Set(rows.map((r) => r.migration_name));
      const missing = expected.filter((m) => !applied.has(m));
      return missing.length === 0
        ? { status: "up", details: { applied: expected.length } }
        : { status: "down", error: "migrations not applied", details: { missing } };
    },
  };
}

/**
 * Soroban RPC quorum: a majority of the configured endpoints must answer
 * `getHealth` with "healthy".
 */
export function rpcQuorumIndicator(
  urls: string[],
  criticalFor: ServiceRole[] = ["worker"],
  fetchImpl: typeof fetch = fetch,
): HealthIndicator {
  return {
    name: "soroban_rpc_quorum",
    criticalFor,
    async check(): Promise<IndicatorResult> {
      const results = await Promise.all(
        urls.map(async (url) => {
          try {
            const res = await fetchImpl(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
              signal: AbortSignal.timeout(2_000),
            });
            const body = (await res.json()) as { result?: { status?: string } };
            return { url, healthy: res.ok && body.result?.status === "healthy" };
          } catch (err) {
            return { url, healthy: false, error: (err as Error).message };
          }
        }),
      );
      const healthy = results.filter((r) => r.healthy).length;
      const quorum = Math.floor(urls.length / 2) + 1;
      return {
        status: healthy >= quorum ? "up" : "down",
        details: { healthy, quorum, endpoints: results },
      };
    },
  };
}

/** Startup "cache warmed" check: the kill-switch snapshot has loaded. */
export function killSwitchIndicator(killSwitch: { isReady(): boolean }): HealthIndicator {
  return {
    name: "killswitch_snapshot",
    // Writes fail closed without the snapshot, so an API replica is not ready.
    criticalFor: ["api"],
    startup: true,
    async check() {
      return killSwitch.isReady() ? { status: "up" } : { status: "down", error: "snapshot not loaded" };
    },
  };
}
