/**
 * HashiCorp Vault KV secrets provider (issue #465).
 *
 * Loads secrets from HashiCorp Vault KV v2 with periodic polling for rotation.
 * The Vault SDK is loaded lazily so this provider is optional.
 *
 * Configuration via environment variables:
 * - `VAULT_ADDR` — Vault server address (required, e.g. https://vault.internal:8200).
 * - `VAULT_TOKEN` — Vault token with KV read permissions (required).
 * - `VAULT_KV_MOUNT` — KV secrets engine mount path (default: "secret").
 * - `VAULT_KV_PREFIX` — optional prefix within the mount (default: "vortex/").
 * - `VAULT_KV_POLL_INTERVAL_MS` — poll interval for rotation (default: 60000).
 *
 * Secret naming: mount/prefix + logical name. E.g. mount `secret/`, prefix
 * `vortex/` + secret `database-url` → path `secret/data/vortex/database-url`.
 */
import { Injectable, Logger } from "@nestjs/common";
import {
  SecretsProvider,
  SecretVersion,
  SecretChangeEvent,
  SecretsWatchHandle,
} from "../secrets.provider";

interface VaultClient {
  readSecret(path: string): Promise<{ data: { data: Record<string, string>; metadata: { version: number } } }>;
  listSecrets(path: string): Promise<{ data: { keys: string[] } }>;
}

interface WatchHandle {
  dispose(): Promise<void>;
}

/**
 * Vault KV v2 provider.
 *
 * Lazy-loads the Vault SDK so it is an optional dependency. If the SDK is not
 * installed, construction will throw with a clear message.
 */
@Injectable()
export class VaultKvProvider implements SecretsProvider {
  readonly name = "vault-kv";
  private readonly logger = new Logger(VaultKvProvider.name);

  private client: VaultClient | null = null;
  private mount: string;
  private prefix: string;
  private pollIntervalMs: number;
  private address: string;
  private token: string;

  constructor() {
    this.address = process.env.VAULT_ADDR ?? "";
    this.token = process.env.VAULT_TOKEN ?? "";
    this.mount = process.env.VAULT_KV_MOUNT ?? "secret";
    this.prefix = process.env.VAULT_KV_PREFIX ?? "vortex/";
    this.pollIntervalMs = parseInt(process.env.VAULT_KV_POLL_INTERVAL_MS ?? "60000", 10);
  }

  private async ensureClient(): Promise<VaultClient> {
    if (this.client) return this.client;

    if (!this.address || !this.token) {
      throw new Error("VaultKvProvider requires VAULT_ADDR and VAULT_TOKEN environment variables");
    }

    // Lazy-load the Vault SDK — this is an optional dependency.
    let Vault: new (config: { apiVersion: string; endpoint: string; token: string }) => VaultClient;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const mod = require("node-vault");
      Vault = mod;
    } catch {
      throw new Error(
        "VaultKvProvider requires node-vault. " +
          "Install it with: npm install node-vault",
      );
    }

    this.client = new Vault({
      apiVersion: "v2",
      endpoint: this.address,
      token: this.token,
    });
    return this.client;
  }

  private toVaultPath(name: string): string {
    // KV v2 paths are mount/data/prefix+name
    return `${this.mount}/data/${this.prefix}${name}`;
  }

  async getSecret(name: string): Promise<SecretVersion | null> {
    const client = await this.ensureClient();
    const path = this.toVaultPath(name);

    try {
      const resp = await client.readSecret(path);
      const data = resp.data?.data;
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      // KV v2 stores multiple key-value pairs; we expect a single "value" key
      // or use the first key if "value" is not present.
      const value = data.value ?? Object.values(data)[0];
      if (value === undefined) {
        return null;
      }

      return {
        version: String(resp.data?.metadata?.version ?? Date.now()),
        value,
        fetchedAt: Date.now(),
      };
    } catch (err: unknown) {
      const e = err as { response?: { status?: number } };
      // 404 = secret does not exist
      if (e.response?.status === 404) {
        return null;
      }
      this.logger.error(`Failed to get secret ${path}: ${(err as Error).message}`);
      throw err;
    }
  }

  async getSecrets(names: string[]): Promise<Map<string, SecretVersion>> {
    const result = new Map<string, SecretVersion>();
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
    await this.ensureClient();
    const pollMs = intervalMs ?? this.pollIntervalMs;
    const knownVersions = new Map<string, string>();

    // Prime the cache
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
        }
      }
    }, pollMs);

    timer.unref();

    return {
      async dispose() {
        clearInterval(timer);
      },
    };
  }

  async close(): Promise<void> {
    this.client = null;
  }
}