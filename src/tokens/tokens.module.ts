import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TokensController } from "./tokens.controller";
import { TokensService } from "./tokens.service";
import { TOKENS_REPOSITORY } from "./tokens.repository";
import { InMemoryTokensRepository } from "./in-memory-tokens.repository";
import { PrismaTokensRepository } from "./prisma-tokens.repository";

@Module({
  controllers: [TokensController],
  providers: [
    {
      provide: TOKENS_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const adapter = process.env.TOKENS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaTokensRepository(prisma);
        }
        return new InMemoryTokensRepository();
      },
    },
    TokensService,
  ],
  exports: [TokensService],
})
export class TokensModule {}
