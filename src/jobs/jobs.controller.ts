import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, RequireAdminRole } from "../admin/admin.guard";
import { JobsService } from "./jobs.service";

/** Admin view of queue health (works for every driver; Bull Board adds a UI on BullMQ). */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller("admin/jobs")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get("queues")
  @ApiOperation({ summary: "Depth and dead-letter counts per queue" })
  async queues() {
    return { queues: await this.jobs.stats() };
  }

  @Get("queues/:queue/dead-letters")
  @ApiOperation({ summary: "Most recent dead-lettered jobs for a queue" })
  async deadLetters(@Param("queue") queue: string) {
    if (!this.jobs.queues().includes(queue)) throw new NotFoundException("Unknown queue");
    return { queue, deadLetters: await this.jobs.deadLetters(queue) };
  }
}
