import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TokensController } from "./tokens.controller";
import { TokensService } from "./tokens.service";
import { TOKENS_REPOSITORY } from "./tokens.repository";
import { InMemoryTokensRepository } from "./in-memory-tokens.repository";
import { PrismaTokensRepository } from "./prisma-tokens.repository";
import { PriceFeedWorker } from "./price-feed.worker";
import { CoinGeckoPriceFeedProvider, PRICE_FEED_PROVIDER } from "./price-feed.provider";

@Module({
  controllers: [TokensController],
  providers: [
    {
      provide: TOKENS_REPOSITORY,
      inject: [PrismaService],
      useFactory: async (prisma: PrismaService) => {
        const adapter = process.env.TOKENS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          const repository = new PrismaTokensRepository(prisma);
          await repository.init();
          return repository;
        }
        return new InMemoryTokensRepository();
      },
    },
    TokensService,
    PriceFeedWorker,
    CoinGeckoPriceFeedProvider,
    { provide: PRICE_FEED_PROVIDER, useExisting: CoinGeckoPriceFeedProvider },
  ],
  exports: [TokensService],
})
export class TokensModule {}
