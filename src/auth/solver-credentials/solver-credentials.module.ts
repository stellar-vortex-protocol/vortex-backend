import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../../config/configuration";
import { PrismaSolverCredentialsRepository } from "./prisma-solver-credentials.repository";
import { SolverCredentialService } from "./solver-credential.service";
import { SolverCredentialController } from "./solver-credential.controller";
import { SolverCredentialGuard } from "./solver-credential.guard";
import { ScopeGuard } from "./scope.guard";
import { SolverJwtGuard } from "./solver-jwt.guard";
import {
  CREDENTIAL_REVOCATION_BUS,
  CredentialRevocationBus,
  InMemoryCredentialRevocationBus,
  RedisCredentialRevocationBus,
} from "./credential-revocation.bus";

/**
 * Scoped solver credentials (issue #443).
 *
 * Provides the credential lifecycle service, the SEP-10-protected endpoints,
 * the credential/scope guards, and the revocation pub/sub bus that propagates
 * revocations to every replica.
 */
@Module({
  controllers: [SolverCredentialController],
  providers: [
    PrismaSolverCredentialsRepository,
    SolverCredentialService,
    SolverCredentialGuard,
    ScopeGuard,
    SolverJwtGuard,
    {
      provide: CREDENTIAL_REVOCATION_BUS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): CredentialRevocationBus => {
        const mode = config.get("credentialRevocationPubsub", { infer: true });
        if (mode === "redis") {
          const url = config.get("redisUrl", { infer: true });
          return new RedisCredentialRevocationBus(url);
        }
        return new InMemoryCredentialRevocationBus();
      },
    },
  ],
  exports: [SolverCredentialService, SolverCredentialGuard, ScopeGuard],
})
export class SolverCredentialsModule {}
