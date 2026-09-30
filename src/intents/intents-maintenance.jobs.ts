import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { defineJob } from "../jobs/jobs.types";
import { JobsService } from "../jobs/jobs.service";
import { IntentsService } from "./intents.service";

export const MAINTENANCE_QUEUE = "maintenance";

/** Store-size log + in-memory retention eviction (was a setInterval in IntentsService). */
export const STORE_SIZE_JOB = defineJob<Record<string, never>>(MAINTENANCE_QUEUE, "intents.store-size", {
  attempts: 3,
  backoffMs: 5_000,
});

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Reference migration of an ad-hoc loop onto the job queue (issue #494).
 * The job only runs where a worker is registered (PROCESS_ROLE worker/all).
 */
@Injectable()
export class IntentsMaintenanceJobs implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly intents: IntentsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.jobs.defineQueue(MAINTENANCE_QUEUE, { concurrency: 1 });
    this.jobs.process(STORE_SIZE_JOB, () => this.intents.logStoreSize());
    const everyMs =
      Number(this.config.get("intentRetentionSweepMs", { infer: true })) || DEFAULT_INTERVAL_MS;
    await this.jobs.schedule(STORE_SIZE_JOB, everyMs, {});
  }
}
