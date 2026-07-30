import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * PrismaService wraps PrismaClient and participates in the NestJS lifecycle.
 *
 * - Connects on module init so the connection pool is warm at startup.
 * - Disconnects on module destroy for clean shutdown (important in tests).
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
}
