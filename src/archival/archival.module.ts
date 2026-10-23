import { Module } from "@nestjs/common";
import { ArchivalService } from "./archival.service";
import { ArchivalJob, ArchivalAdminController } from "./archival.job";

/**
 * ArchivalModule (#413).
 *
 * Registers the daily archival job, the ArchivalService, the admin restore
 * controller (#696) and the restore background job handler (#696).
 * Import in AppModule; the job is a no-op when ARCHIVAL_ENABLED=false.
 *
 * Requires PrismaModule (global), JobsModule (global) and @nestjs/schedule
 * (via ScheduleModule).
 */
@Module({
  controllers: [ArchivalAdminController],
  providers: [ArchivalService, ArchivalJob],
  exports: [ArchivalService],
})
export class ArchivalModule {}
