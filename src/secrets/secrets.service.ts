/**
 * SecretsService (issue #465).
 *
 * Central service that loads secrets from a pluggable {@link SecretsProvider},
 * supports hot reload with versioned secrets, and publishes change events so
 * consumers (JWT verification, DB pool, etc.) can react to rotations without
 * restarting the process.
 *
 * Key features:
 * - Multiple provider implementations (env, AWS Secrets Manager, Vault KV)
 * - Periodic refresh with change detection
 * - Versioned secrets: JWT verification accepts current + previous key during
 *   the rotation overlap window
 * - Secrets never logged (integrates with src/soroban/redaction.ts)
 * - Fail-closed startup in production when provider is unreachable
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
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
import { EnvProvider } from "./providers/env.provider";
import { AwsSecretsManagerProvider } from "./providers/aws-secrets-manager.provider";
import { VaultKvProvider } from "./providers/vault-kv.provider";

/** Simple in-memory event emitter to avoid @nestjs/event-emitter dependency. */
class SimpleEventEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on<T extends unknown[]>(event: string, listener: (...args: T) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (...args: unknown[]) => void);
    return this;
  }

  off<T extends unknown[]>(event: string, listener: (...args: T) => void): this {
    this.listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const handlers = this.listeners.get(event);
    if (!handlers) return false;
    for (const listener of handlers) {
      try {
        listener(...args);
      } catch (e) {
        console.error(`Event listener error for ${event}:`, e);
      }
    }
    return true;
  }
}

@Injectable()
export class SecretsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecretsService.name);
  private provider: SecretsProvider;
  private watchHandle: SecretsWatchHandle | null = null;
  private secretCache = new Map<string, SecretVersion>();
  private previousVersions = new Map<string, SecretVersion>();
  private readonly secretConfigs: SecretConfig[];
  private readonly mappings: SecretMapping[];
  private readonly eventEmitter = new SimpleEventEmitter();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject("SECRETS_PROVIDER") injectedProvider?: SecretsProvider,
  ) {
    // Load secret configs from configuration
    this.secretConfigs = this.loadSecretConfigs();
    this.mappings = this.loadMappings();

    // Use injected provider (for testing) or create from config
    this.provider = injectedProvider ?? this.createProviderFromConfig();
  }

  /** Create the provider instance based on SECRETS_PROVIDER env var. */
  private createProviderFromConfig(): SecretsProvider {
    const providerName = this.config.get<string>("secrets.provider") ?? "env";

    switch (providerName) {
      case "aws-secrets-manager":
        return new AwsSecretsManagerProvider();
      case "vault-kv":
        return new VaultKvProvider();
      case "env":
      default:
        return new EnvProvider();
    }
  }

  /** Load secret configs from SECRETS_* env vars or defaults. */
  private loadSecretConfigs(): SecretConfig[] {
    // Default secret mappings — extend via env if needed
    const defaults: SecretConfig[] = [
      { name: "database-url", envVar: "DATABASE_URL", required: true, description: "PostgreSQL connection string" },
      { name: "jwt-signing-key", envVar: "JWT_SIGNING_KEY", required: true, description: "HS256/RS256 signing key" },
      { name: "soroban-signing-key", envVar: "SOROBAN_SIGNING_KEY", required: false, description: "Stellar secret seed for on-chain writes" },
      { name: "webhook-secret", envVar: "WEBHOOK_SECRET", required: false, description: "Webhook signature verification secret" },
      { name: "channel-key", envVar: "CHANNEL_KEY", required: false, description: "Encryption key for channel data" },
      { name: "killswitch-operator-token", envVar: "KILLSWITCH_OPERATOR_TOKEN", required: false, description: "Emergency pause control plane token" },
      { name: "admin-api-keys", envVar: "ADMIN_API_KEYS", required: false, description: "Admin RBAC keys" },
      { name: "sentry-dsn", envVar: "SENTRY_DSN", required: false, description: "Sentry error reporting DSN" },
      { name: "log-shipping-host", envVar: "LOG_SHIPPING_HOST", required: false, description: "Log shipper host" },
      { name: "vault-token", envVar: "VAULT_TOKEN", required: false, description: "Vault authentication token" },
    ];

    // Allow additional secrets via SECRETS_EXTRA (comma-separated "name:envVar:required")
    const extra = this.config.get<string>("secrets.extra") ?? "";
    if (extra.trim()) {
      for (const part of extra.split(",")) {
        const [name, envVar, required] = part.split(":");
        if (name) {
          defaults.push({
            name: name.trim(),
            envVar: envVar?.trim(),
            required: required === "true",
            description: `Extra secret: ${name.trim()}`,
          });
        }
      }
    }

    return defaults;
  }

  /** Load the mapping from secret names to config keys. */
  private loadMappings(): SecretMapping[] {
    return [
      { configKey: "databaseUrl", previousKeyConfigKey: "previousDatabaseUrl", rotationOverlapMs: 30000 },
      { configKey: "signingKey", previousKeyConfigKey: "previousSigningKey", rotationOverlapMs: 300000 }, // 5 min for JWT
      { configKey: "stellar.signingKey" },
      { configKey: "webhookSecret" },
      { configKey: "channelKey" },
      { configKey: "killswitch.operatorToken" },
      { configKey: "adminApiKeys" },
      { configKey: "sentryDsn" },
      { configKey: "logShippingHost" },
      { configKey: "vaultToken" },
    ];
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Initializing SecretsService with provider: ${this.provider.name}`);

    // Load all secrets at startup
    await this.refreshAllSecrets();

    // In production, fail closed if required secrets are missing
    if (this.config.get<string>("NODE_ENV") === "production") {
      for (const cfg of this.secretConfigs) {
        if (cfg.required && !this.secretCache.has(cfg.name)) {
          const msg = `Required secret "${cfg.name}" (${cfg.description}) not found from provider ${this.provider.name}`;
          this.logger.error(msg);
          throw new Error(msg);
        }
      }
    }

    // Start watching for changes
    const names = this.secretConfigs.map((c) => c.name);
    const intervalMs = this.config.get<number>("secrets.refreshIntervalMs") ?? 60000;
    this.watchHandle = await this.provider.watchSecrets(names, this.handleSecretChange.bind(this), intervalMs);

    this.logger.log(`SecretsService started watching ${names.length} secrets`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.watchHandle) {
      await this.watchHandle.dispose();
      this.watchHandle = null;
    }
    await this.provider.close();
  }

  /** Handle a secret rotation event from the provider. */
  private handleSecretChange(event: SecretChangeEvent): void {
    this.logger.log(`Secret rotated: ${event.name} (v${event.newVersion.version})`);

    // Move current to previous for the overlap window
    const current = this.secretCache.get(event.name);
    if (current) {
      this.previousVersions.set(event.name, current);

      // Schedule cleanup of the previous version after the overlap window
      const mapping = this.mappings.find((m) => m.configKey.includes(event.name) || event.name.includes(m.configKey.split(".").pop() ?? ""));
      const overlapMs = mapping?.rotationOverlapMs ?? 300000; // default 5 min
      setTimeout(() => {
        this.previousVersions.delete(event.name);
        this.logger.debug(`Rotation overlap expired for ${event.name}, previous version evicted`);
      }, overlapMs);
    }

    // Update cache with new version
    this.secretCache.set(event.name, event.newVersion);

    // Emit event for consumers (JWT, DB pool, etc.)
    this.eventEmitter.emit(SECRET_ROTATED_EVENT, event);
  }

  /** Refresh all configured secrets from the provider. */
  async refreshAllSecrets(): Promise<void> {
    const names = this.secretConfigs.map((c) => c.name);
    const results = await this.provider.getSecrets(names);

    for (const [name, version] of results) {
      this.secretCache.set(name, version);
    }

    // Check for missing required secrets
    for (const cfg of this.secretConfigs) {
      if (cfg.required && !this.secretCache.has(cfg.name)) {
        this.logger.warn(`Required secret "${cfg.name}" not found from provider`);
      }
    }
  }

  /** Get a secret value by logical name. */
  getSecret(name: string): SecretResult {
    const version = this.secretCache.get(name);
    if (!version) {
      return { notFound: true, error: new Error(`Secret ${name} not loaded`) };
    }
    return { value: version.value, version: version.version, notFound: false };
  }

  /** Get a secret value with fallback to previous version (for JWT rotation). */
  getSecretWithPrevious(name: string): { current?: SecretResult; previous?: SecretResult } {
    const current = this.getSecret(name);
    const previousVersion = this.previousVersions.get(name);
    const previous = previousVersion
      ? { value: previousVersion.value, version: previousVersion.version, notFound: false }
      : { notFound: true as const };

    return { current, previous };
  }

  /** Get all secret names currently loaded. */
  getLoadedSecretNames(): string[] {
    return [...this.secretCache.keys()];
  }

  /** Get the provider name. */
  getProviderName(): string {
    return this.provider.name;
  }

  /** Check if a secret exists in the cache. */
  hasSecret(name: string): boolean {
    return this.secretCache.has(name);
  }

  /** Subscribe to secret rotation events. */
  onSecretRotated(listener: (event: SecretChangeEvent) => void): () => void {
    this.eventEmitter.on(SECRET_ROTATED_EVENT, listener);
    return () => this.eventEmitter.off(SECRET_ROTATED_EVENT, listener);
  }

  /** Subscribe to secret error events. */
  onSecretError(listener: (event: SecretChangeEvent) => void): () => void {
    this.eventEmitter.on(SECRET_ERROR_EVENT, listener);
    return () => this.eventEmitter.off(SECRET_ERROR_EVENT, listener);
  }
}