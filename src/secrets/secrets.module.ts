/**
 * Secrets module (issue #465).
 *
 * Provides the SecretsService and the configured SecretsProvider.
 * The provider is selected via the SECRETS_PROVIDER environment variable:
 * - "env" (default) — reads from process.env
 * - "aws-secrets-manager" — reads from AWS Secrets Manager
 * - "vault-kv" — reads from HashiCorp Vault KV v2
 */
import { Module, Global, DynamicModule, Provider } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { SecretsService } from "./secrets.service";
import { SecretsProvider } from "./secrets.provider";
import { EnvProvider } from "./providers/env.provider";
import { AwsSecretsManagerProvider } from "./providers/aws-secrets-manager.provider";
import { VaultKvProvider } from "./providers/vault-kv.provider";

const SECRETS_PROVIDER_TOKEN = "SECRETS_PROVIDER";

@Global()
@Module({})
export class SecretsModule {
  static forRoot(): DynamicModule {
    const providerFactory: Provider = {
      provide: SECRETS_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SecretsProvider => {
        const providerName = config.get<string>("secrets.provider") ?? "env";

        switch (providerName) {
          case "aws-secrets-manager":
            return new AwsSecretsManagerProvider();
          case "vault-kv":
            return new VaultKvProvider();
          case "env":
          default:
            return new EnvProvider();
        }
      },
    };

    return {
      module: SecretsModule,
      imports: [ConfigModule],
      providers: [providerFactory, SecretsService],
      exports: [SecretsService, SECRETS_PROVIDER_TOKEN],
    };
  }

  static forTest(provider: SecretsProvider): DynamicModule {
    return {
      module: SecretsModule,
      providers: [
        { provide: SECRETS_PROVIDER_TOKEN, useValue: provider },
        SecretsService,
      ],
      exports: [SecretsService, SECRETS_PROVIDER_TOKEN],
    };
  }
}

export { SECRETS_PROVIDER_TOKEN };
export { SecretsService } from "./secrets.service";
export { SecretsProvider, SecretVersion, SecretChangeEvent, SecretsWatchHandle, SecretResult, SecretConfig, SecretMapping, SECRET_ROTATED_EVENT, SECRET_ERROR_EVENT } from "./secrets.provider";
export { EnvProvider } from "./providers/env.provider";
export { AwsSecretsManagerProvider } from "./providers/aws-secrets-manager.provider";
export { VaultKvProvider } from "./providers/vault-kv.provider";