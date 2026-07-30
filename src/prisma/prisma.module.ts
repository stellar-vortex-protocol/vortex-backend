import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/**
 * PrismaModule is marked `@Global()` so any feature module can inject
 * PrismaService without needing to import PrismaModule explicitly.
 *
 * Import this module once in AppModule.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
