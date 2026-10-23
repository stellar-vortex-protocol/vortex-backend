import { Module } from "@nestjs/common";
import { ArchivalService } from "./archival.service";
import { ArchivalJob, ArchivalAdminController, ArchivalIntegrityJob } from "./archival.job";
import { MetricsModule } from "../metrics/metrics.module";

/**
 * ArchivalModule (#413).
 *
 * Registers the daily archival job, the scheduled integrity re-verification
 * job (#697), the ArchivalService, the admin restore controller (#696) and
 * the restore background job handler (#696).
 * Import in AppModule; the job is a no-op when ARCHIVAL_ENABLED=false.
 *
 * Requires PrismaModule (global), JobsModule (global) and @nestjs/schedule
 * (via ScheduleModule).
 * MetricsModule is imported so the integrity job can inject MetricsService.
 */
@Module({
  imports: [MetricsModule],
  controllers: [ArchivalAdminController],
  providers: [ArchivalService, ArchivalJob, ArchivalIntegrityJob],
  exports: [ArchivalService],
})
export class ArchivalModule {}