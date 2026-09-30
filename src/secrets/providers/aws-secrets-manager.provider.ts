/**
 * AWS Secrets Manager provider (issue #465).
 *
 * Loads secrets from AWS Secrets Manager with periodic polling for rotation.
 * The AWS SDK is loaded lazily so this provider is optional — it will not
 * cause a build failure if `@aws-sdk/client-secrets-manager` is not installed.
 *
 * Configuration via environment variables:
 * - `AWS_SECRETS_MANAGER_PREFIX` — optional prefix prepended to secret names (default: "").
 * - `AWS_REGION` — AWS region (required, or uses SDK default).
 * - `AWS_SECRETS_MANAGER_POLL_INTERVAL_MS` — poll interval for rotation (default: 60000).
 *
 * Secret naming: the logical secret name is combined with the prefix to form
 * the AWS secret name. E.g. prefix `/prod/vortex/` + secret `database-url` →
 * AWS secret `/prod/vortex/database-url`.
 */
import { Injectable, Logger } from "@nestjs/common";
import {
  SecretsProvider,
  SecretVersion,
  SecretChangeEvent,
  SecretsWatchHandle,
} from "../secrets.provider";

interface AWSSecretsManagerClient {
  getSecretValue(args: { SecretId: string }): Promise<{ SecretString?: string; VersionId?: string; Name?: string }>;
  listSecrets(args: { Filters?: Array<{ Key: "name"; Values: string[] }> }): Promise<{ SecretList?: Array<{ Name: string }> }>;
}

interface WatchHandle {
  dispose(): Promise<void>;
}

/**
 * AWS Secrets Manager provider.
 *
 * Lazy-loads the AWS SDK so it is an optional dependency. If the SDK is not
 * installed, construction will throw with a clear message.
 */
@Injectable()
export class AwsSecretsManagerProvider implements SecretsProvider {
  readonly name = "aws-secrets-manager";
  private readonly logger = new Logger(AwsSecretsManagerProvider.name);

  private client: AWSSecretsManagerClient | null = null;
  private prefix: string;
  private pollIntervalMs: number;

  constructor() {
    this.prefix = process.env.AWS_SECRETS_MANAGER_PREFIX ?? "";
    this.pollIntervalMs = parseInt(process.env.AWS_SECRETS_MANAGER_POLL_INTERVAL_MS ?? "60000", 10);
  }

  private async ensureClient(): Promise<AWSSecretsManagerClient> {
    if (this.client) return this.client;

    // Lazy-load the AWS SDK — this is an optional dependency.
    let SecretsManagerClient: new (config: { region?: string }) => AWSSecretsManagerClient;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const mod = require("@aws-sdk/client-secrets-manager");
      SecretsManagerClient = mod.SecretsManagerClient;
    } catch {
      throw new Error(
        "AwsSecretsManagerProvider requires @aws-sdk/client-secrets-manager. " +
          "Install it with: npm install @aws-sdk/client-secrets-manager",
      );
    }

    this.client = new SecretsManagerClient({ region: process.env.AWS_REGION });
    return this.client;
  }

  private toAwsSecretName(name: string): string {
    return `${this.prefix}${name}`;
  }

  async getSecret(name: string): Promise<SecretVersion | null> {
    const client = await this.ensureClient();
    const secretName = this.toAwsSecretName(name);

    try {
      const resp = await client.getSecretValue({ SecretId: secretName });
      if (!resp.SecretString) {
        this.logger.warn(`Secret ${secretName} exists but has no SecretString`);
        return null;
      }
      return {
        version: resp.VersionId ?? `aws-${Date.now()}`,
        value: resp.SecretString,
        fetchedAt: Date.now(),
      };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      // ResourceNotFoundException = secret does not exist
      if (e.name === "ResourceNotFoundException" || e.$metadata?.httpStatusCode === 404) {
        return null;
      }
      this.logger.error(`Failed to get secret ${secretName}: ${(err as Error).message}`);
      throw err;
    }
  }

  async getSecrets(names: string[]): Promise<Map<string, SecretVersion>> {
    const client = await this.ensureClient();
    const result = new Map<string, SecretVersion>();

    // AWS GetSecretValue is one secret per call; batch via ListSecrets + parallel GetSecretValue
    // For small numbers of secrets, parallel calls are fine.
    await Promise.all(
      names.map(async (name) => {
        const version = await this.getSecret(name);
        if (version) {
          result.set(name, version);
        }
      }),
    );
    return result;
  }

  async watchSecrets(
    names: string[],
    onChange: (event: SecretChangeEvent) => void,
    intervalMs?: number,
  ): Promise<SecretsWatchHandle> {
    const client = await this.ensureClient();
    const pollMs = intervalMs ?? this.pollIntervalMs;
    const knownVersions = new Map<string, string>();

    // Prime the cache with current versions
    for (const name of names) {
      const version = await this.getSecret(name);
      if (version) {
        knownVersions.set(name, version.version);
      }
    }

    const timer = setInterval(async () => {
      for (const name of names) {
        try {
          const version = await this.getSecret(name);
          const previousVersion = knownVersions.get(name) ?? null;

          if (!version) {
            // Secret disappeared — treat as a change if it existed before
            if (previousVersion) {
              knownVersions.delete(name);
              onChange({
                name,
                newVersion: { version: "", value: "", fetchedAt: Date.now() },
                previousVersion: { version: previousVersion, value: "", fetchedAt: 0 },
              });
            }
            continue;
          }

          if (previousVersion !== version.version) {
            knownVersions.set(name, version.version);
            onChange({
              name,
              newVersion: version,
              previousVersion: previousVersion
                ? { version: previousVersion, value: "", fetchedAt: 0 }
                : null,
            });
          }
        } catch (err) {
          this.logger.warn(`Poll failed for secret ${name}: ${(err as Error).message}`);
          // Don't crash the watch loop on transient errors
        }
      }
    }, pollMs);

    timer.unref(); // Don't prevent process exit

    return {
      async dispose() {
        clearInterval(timer);
      },
    };
  }

  async close(): Promise<void> {
    // The AWS SDK client doesn't have an explicit close; it's just HTTP connections.
    this.client = null;
  }
}