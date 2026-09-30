/**
 * Environment-variable secrets provider (issue #465).
 *
 * Reads secrets from `process.env`. This is the default provider for
 * development and test environments; it requires no external dependencies
 * and works with the existing `.env*` workflow.
 *
 * Since environment variables cannot change at runtime without a process
 * restart, the watch mechanism is a no-op that never fires change events.
 * It exists only to satisfy the {@link SecretsProvider} interface.
 */
import { Injectable, Logger } from "@nestjs/common";
import {
  SecretsProvider,
  SecretVersion,
  SecretChangeEvent,
  SecretsWatchHandle,
} from "../secrets.provider";

/** No-op watch handle returned by the env provider. */
class NoOpWatchHandle implements SecretsWatchHandle {
  async dispose(): Promise<void> {
    // Nothing to do.
  }
}

/**
 * EnvProvider reads secret values from `process.env`.
 *
 * Secret names are mapped to environment variables via a simple convention:
 * the secret name in kebab-case becomes the environment variable in
 * SCREAMING_SNAKE_CASE (e.g. `database-url` → `DATABASE_URL`).
 *
 * For custom mappings, use the `envVar` field in {@link SecretConfig}.
 */
@Injectable()
export class EnvProvider implements SecretsProvider {
  readonly name = "env";
  private readonly logger = new Logger(EnvProvider.name);

  /**
   * Convert a logical secret name to the corresponding environment variable.
   *
   * @param name Logical secret name (kebab-case).
   * @returns Environment variable name (SCREAMING_SNAKE_CASE).
   */
  static toEnvVar(name: string): string {
    return name.toUpperCase().replace(/-/g, "_");
  }

  async getSecret(name: string): Promise<SecretVersion | null> {
    const envVar = EnvProvider.toEnvVar(name);
    const value = process.env[envVar];
    if (value === undefined || value === "") {
      return null;
    }
    return {
      version: `env-${Date.now()}`,
      value,
      fetchedAt: Date.now(),
    };
  }

  async getSecrets(names: string[]): Promise<Map<string, SecretVersion>> {
    const result = new Map<string, SecretVersion>();
    for (const name of names) {
      const version = await this.getSecret(name);
      if (version) {
        result.set(name, version);
      }
    }
    return result;
  }

  async watchSecrets(
    _names: string[],
    _onChange: (event: SecretChangeEvent) => void,
    _intervalMs?: number,
  ): Promise<SecretsWatchHandle> {
    this.logger.debug("EnvProvider.watchSecrets called — environment variables cannot change at runtime; returning no-op handle.");
    return new NoOpWatchHandle();
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}