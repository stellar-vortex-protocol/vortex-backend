/**
 * scripts/export-datasets.ts
 *
 * Daily public dataset export job (docs/rfcs/0001-public-anonymised-datasets.md).
 *
 * Publishes the previous UTC day (or an explicit date) as anonymised CSV +
 * Parquet datasets with a `manifest.json` (schema version, row counts, SHA-256
 * checksums, high-water mark) to the public object-storage bucket.
 *
 * Intended to be run by a scheduler (cron / Kubernetes CronJob / Cloud Scheduler)
 * once per day:
 *
 *   npm run export:datasets              # publishes the current UTC day
 *   npm run export:datasets -- 2026-09-27  # re-publish a specific date (reconciliation)
 *
 * Re-running a date increments the publication `revision` rather than
 * overwriting history, so late-arriving data can be repaired idempotently.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { DatasetsService } from "../src/datasets/datasets.service";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const service = app.get(DatasetsService);
  const dateArg = process.argv[2];

  let date: Date;
  if (dateArg) {
    const parsed = new Date(`${dateArg}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid date argument: ${dateArg} (expected YYYY-MM-DD)`);
    }
    date = parsed;
  } else {
    date = new Date();
  }

  const manifest = await service.exportDaily(date);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(manifest, null, 2));

  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
