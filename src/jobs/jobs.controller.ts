import { Controller, Delete, Get, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, RequireAdminRole } from "../admin/admin.guard";
import { JobsService } from "./jobs.service";

@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
@Controller("admin/jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get("queues")
  @ApiOperation({ summary: "Queue depths and dead-letter counts" })
  async queues() {
    return { queues: await this.jobs.stats() };
  }

  @Get("queues/:queue/dead-letters")
  @ApiOperation({ summary: "Inspect jobs that exhausted all retry attempts" })
  async deadLetters(@Param("queue") queue: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    return { queue, deadLetters: await this.jobs.deadLetters(queue) };
  }

  @Post("queues/:queue/dead-letters/:jobId/retry")
  @ApiOperation({ summary: "Re-enqueue a specific dead-lettered job for another attempt" })
  async retryDeadLetter(@Param("queue") queue: string, @Param("jobId") jobId: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    const retried = await this.jobs.retryDeadLetter(queue, jobId);
    if (!retried) throw new NotFoundException("Dead-lettered job not found");
    return { queue, jobId, retried: true };
  }

  @Get("queues/:queue/jobs/:jobId")
  @ApiOperation({ summary: "Status and result of a specific job" })
  async jobResult(@Param("queue") queue: string, @Param("jobId") jobId: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    return this.jobs.getResult(queue, jobId);
  }

  @Delete("queues/:queue/jobs/:jobId")
  @ApiOperation({ summary: "Cancel a pending, delayed, or scheduled job in a queue" })
  async cancel(@Param("queue") queue: string, @Param("jobId") jobId: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    return { cancelled: await this.jobs.cancel(queue, jobId) };
  }

  @Get("queues/:queue/schedules")
  @ApiOperation({ summary: "List active repeating job schedules for a queue" })
  async schedules(@Param("queue") queue: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    return { queue, schedules: await this.jobs.listSchedules(queue) };
  }

  @Delete("queues/:queue/schedules/:name")
  @ApiOperation({ summary: "Cancel a repeating job schedule by name" })
  async unschedule(@Param("queue") queue: string, @Param("name") name: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    const removed = await this.jobs.unschedule(queue, name);
    if (!removed) throw new NotFoundException("Schedule not found");
    return { queue, name, removed: true };
  }
}
