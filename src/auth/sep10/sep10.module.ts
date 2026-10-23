import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { AppConfig } from "../../config/configuration";
import { SolversModule } from "../../solvers/solvers.module";
import { WellKnownController } from "../../well-known/well-known.controller";
import { HorizonAccountInfoLoader, SEP10_ACCOUNT_INFO_LOADER } from "./account-info";
import {
  InMemorySep10NonceStore,
  RedisSep10NonceStore,
  SEP10_NONCE_STORE,
  type Sep10NonceStore,
} from "./nonce.store";
import { JwksController } from "./jwks.controller";
import { Sep10Controller } from "./sep10.controller";
import { Sep10Service } from "./sep10.service";
import { SEP10_KEYS, sep10Keys } from "./sep10-keys";

/**
 * SEP-10 challenge authentication (issue #442): the challenge/token
 * endpoints, the single-use nonce store (`SEP10_NONCE_STORE=redis` for
 * shared replay protection, process-local `memory` otherwise), the Horizon
 * signer/threshold loader, and the process-wide challenge/JWT key material.
 */
@Module({
  imports: [SolversModule],
  controllers: [Sep10Controller, JwksController],
  providers: [
    Sep10Service,
    {
      provide: SEP10_KEYS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        sep10Keys(
          config.get("stellar.signerSecretKey", { infer: true }),
          config.get("sep10JwtSigningKey", { infer: true }),
        ),
    },
    {
      provide: SEP10_NONCE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Sep10NonceStore => {
        if (config.get("sep10NonceStore", { infer: true }) === "redis") {
          return new RedisSep10NonceStore(new Redis(config.get("redisUrl", { infer: true })));
        }
        return new InMemorySep10NonceStore();
      },
    },
    {
      provide: SEP10_ACCOUNT_INFO_LOADER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new HorizonAccountInfoLoader(config.get("stellar.horizonUrl", { infer: true })),
    },
  ],
  exports: [Sep10Service, SEP10_KEYS],
})
export class Sep10Module {}

/**
 * SEP-1 discovery surface (issue #701): serves
 * `GET /.well-known/stellar.toml` so off-the-shelf SEP-10 clients can
 * resolve `WEB_AUTH_ENDPOINT`/`SIGNING_KEY` without out-of-band config.
 * Kept separate from `Sep10Module` because `.well-known` routes are
 * unauthenticated and live outside the `/api/v1` versioned prefix.
 */
@Module({
  imports: [Sep10Module],
  controllers: [WellKnownController],
})
export class WellKnownModule {}
