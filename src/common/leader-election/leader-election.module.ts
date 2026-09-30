import { DynamicModule, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LeaderElectionService, DEFAULT_HEARTBEAT_INTERVAL_MS } from "./leader-election.service";
import { LEADER_ELECTION_BACKEND, LeaderElectionBackend } from "./leader-election.types";
import { PostgresAdvisoryLockBackend } from "./postgres-advisory-lock.backend";
import { AppConfig } from "../../config/configuration";

export interface LeaderElectionModuleOptions {
  /**
   * When true, leader election is disabled and every worker considers itself
   * the leader unconditionally. Useful for single-instance dev/test
   * deployments where DB is unavailable or LEADER_ELECTION_ENABLED=false.
   */
  disabled?: boolean;
}

/**
 * LeaderElectionModule
 * ────────────────────
 * @Global() module that wires LeaderElectionService with the Postgres
 * advisory-lock backend.
 *
 * Import once in AppModule; all other modules get LeaderElectionService
 * via DI without importing this module again.
 *
 * ```ts
 * // app.module.ts
 * LeaderElectionModule.forRoot(),
 * ```
 *
 * The module reads `LEADER_ELECTION_ENABLED` from config at startup:
 *  - false (default) → no-op backend, workers start unconditionally
 *  - true            → Postgres advisory-lock backend
 *
 * IMPORTANT: the Postgres backend uses a dedicated connection. Do NOT
 * route it through PgBouncer in transaction-pooling mode — advisory locks
 * are session-scoped and will be silently dropped when the connection is
 * returned to the pool. Use a direct TCP connection or PgBouncer in
 * session mode.
 */
@Module({})
export class LeaderElectionModule {
  static forRoot(options: LeaderElectionModuleOptions = {}): DynamicModule {
    return {
      module: LeaderElectionModule,
      global: true,
      providers: [
        {
          provide: LEADER_ELECTION_BACKEND,
          inject: [ConfigService],
          useFactory: (configService: ConfigService<AppConfig, true>): LeaderElectionBackend => {
            // Read config — fall back gracefully if the key doesn't exist yet.
            const leaderElectionConfig = configService.get("leaderElection", { infer: true }) as
              | AppConfig["leaderElection"]
              | undefined;
            const enabled = leaderElectionConfig?.enabled ?? false;

            if (options.disabled || !enabled) {
              // No-op backend: always returns token=1 (unconditional leader).
              // Workers behave exactly as before leader election was added.
              return {
                tryAcquire: async () => 1,
                renew: async () => true,
                release: async () => undefined,
              };
            }

            const databaseUrl = configService.get("databaseUrl", { infer: true });
            return new PostgresAdvisoryLockBackend(databaseUrl);
          },
        },
        {
          provide: LeaderElectionService,
          inject: [LEADER_ELECTION_BACKEND, ConfigService],
          useFactory: (
            backend: LeaderElectionBackend,
            configService: ConfigService<AppConfig, true>,
          ): LeaderElectionService => {
            const leaderElectionConfig = configService.get("leaderElection", { infer: true }) as
              | AppConfig["leaderElection"]
              | undefined;
            const heartbeatMs =
              leaderElectionConfig?.heartbeatMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
            // MetricsService is injected lazily via the service itself using @Optional
            return new LeaderElectionService(backend, undefined, heartbeatMs);
          },
        },
      ],
      exports: [LeaderElectionService],
    };
  }
}
