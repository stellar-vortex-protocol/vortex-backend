/**
 * Secrets module public API (issue #465).
 *
 * Provides pluggable secrets management with hot reload and rotation support.
 */
export { SecretsModule, SECRETS_PROVIDER_TOKEN } from "./secrets.module";
export { SecretsService } from "./secrets.service";
export {
  SecretsProvider,
  SecretVersion,
  SecretChangeEvent,
  SecretsWatchHandle,
  SecretResult,
  SecretConfig,
  SecretMapping,
  SECRET_ROTATED_EVENT,
  SECRET_ERROR_EVENT,
} from "./secrets.provider";
export { EnvProvider } from "./providers/env.provider";
export { AwsSecretsManagerProvider } from "./providers/aws-secrets-manager.provider";
export { VaultKvProvider } from "./providers/vault-kv.provider";