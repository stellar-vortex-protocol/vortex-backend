import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpEgressService } from "../common/http-egress";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { AdminTokensController } from "./admin-tokens.controller";
import { AdminTokensService, TokenListPublisher } from "./admin-tokens.service";
import { TokensController } from "./tokens.controller";
import { TokensService } from "./tokens.service";
import { TOKENS_REPOSITORY } from "./tokens.repository";
import { InMemoryTokensRepository } from "./in-memory-tokens.repository";
import { PrismaTokensRepository } from "./prisma-tokens.repository";
import { EvmTokenVerifier } from "./verification/evm-token.verifier";
import { HttpEvmChainReader } from "./verification/http-evm-chain.reader";
import { SdkSacSimulator } from "./verification/sdk-sac.simulator";
import { SimulatedSacReader } from "./verification/simulated-sac.reader";
import { StellarTokenVerifier } from "./verification/stellar-token.verifier";
import { TokenVerifierService } from "./verification/token-verifier.service";

@Module({
  controllers: [TokensController, AdminTokensController],
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
    TokenListPublisher,
    {
      provide: EvmTokenVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new EvmTokenVerifier(
          new HttpEvmChainReader(
            config.get("evmRpcUrls", { infer: true }),
            new HttpEgressService({
              timeoutMs: 10_000,
              maxRedirects: 0,
              maxBodySizeBytes: 1_000_000,
              blockPrivateRanges: true,
            }),
          ),
        ),
    },
    {
      provide: StellarTokenVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const simulator = new SdkSacSimulator(
          config.get("stellar.sorobanRpcUrl", { infer: true }),
          config.get("shadow.sourceAccount", { infer: true }),
          config.get("stellar.network", { infer: true }),
        );
        return new StellarTokenVerifier(new SimulatedSacReader(simulator));
      },
    },
    TokenVerifierService,
    AdminTokensService,
    TokensService,
  ],
  exports: [TokensService, TokenListPublisher],
})
export class TokensModule {}
