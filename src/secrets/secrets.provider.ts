/**
 * SecretsProvider interface and core types (issue #465).
 *
 * A secrets provider loads sensitive configuration from an external source
 * (environment variables, AWS Secrets Manager, HashiCorp Vault KV, etc.) and
 * supports periodic refresh with versioned secrets so keys can be rotated
 * without a process restart.
 */
export interface SecretVersion {
  /** Opaque version identifier returned by the provider (e.g. AWS VersionId, Vault version). */
  version: string;
  /** The secret value itself. */
  value: string;
  /** When this version was fetched (epoch ms). */
  fetchedAt: number;
}

export interface SecretChangeEvent {
  /** Name of the secret that changed. */
  name: string;
  /** The new version. */
  newVersion: SecretVersion;
  /** The previous version (if any). */
  previousVersion: SecretVersion | null;
}

/**
 * A pluggable secrets backend.
 *
 * Implementations MUST be safe for concurrent use and MUST NOT log secret
 * values at any log level.
 */
export interface SecretsProvider {
  /** Human-readable name of the provider (e.g. "env", "aws-secrets-manager", "vault-kv"). */
  readonly name: string;

  /**
   * Load a single secret by name.
   *
   * @param name Logical secret name (e.g. "database-url", "jwt-signing-key").
   * @returns The latest version, or null if the secret does not exist.
   */
  getSecret(name: string): Promise<SecretVersion | null>;

  /**
   * Load multiple secrets in one round-trip where the provider supports it.
   * Default implementation calls {@link getSecret} sequentially.
   *
   * @param names Logical secret names to load.
   * @returns Map of name → version (missing secrets are omitted).
   */
  getSecrets(names: string[]): Promise<Map<string, SecretVersion>>;

  /**
   * Start periodic refresh of the given secrets.
   *
   * The provider MUST emit a {@link SecretChangeEvent} via the callback
   * whenever a secret's version changes. Implementations should avoid
   * spurious events (e.g. only emit when the version string differs).
   *
   * @param names Secrets to watch.
   * @param onChange Called with the new and previous version when a secret rotates.
   * @param intervalMs Poll interval. Defaults to provider-specific sensible value.
   * @returns A handle that stops the refresh when disposed.
   */
  watchSecrets(
    names: string[],
    onChange: (event: SecretChangeEvent) => void,
    intervalMs?: number,
  ): Promise<SecretsWatchHandle>;

  /**
   * Close any underlying connections. Called on application shutdown.
   */
  close(): Promise<void>;
}

/** Opaque handle returned by {@link SecretsProvider.watchSecrets}. */
export interface SecretsWatchHandle {
  /** Stop watching and release resources. */
  dispose(): Promise<void>;
}

/**
 * Result of a secret lookup that may fail.
 *
 * Used by {@link SecretsService} to distinguish "secret not found" from
 * "provider unreachable" so the caller can decide whether to fail closed.
 */
export interface SecretResult {
  /** The secret value, or undefined if not found. */
  value?: string;
  /** The version that produced this value, or undefined if not found. */
  version?: string;
  /** Provider-specific error if the lookup failed (network, auth, etc.). */
  error?: Error;
  /** True when the provider was reachable but the secret does not exist. */
  notFound: boolean;
}

/**
 * Configuration for a single secret consumed by the application.
 */
export interface SecretConfig {
  /** Logical name used with the provider. */
  name: string;
  /** Environment variable name that holds the value when using the env provider. */
  envVar?: string;
  /** Whether this secret is required at startup. */
  required?: boolean;
  /** Human-readable description for docs / error messages. */
  description?: string;
}

/**
 * Mapping from logical secret name to the application config key it populates.
 *
 * Example:
 * ```
 * {
 *   'database-url': { configKey: 'databaseUrl', required: true },
 *   'jwt-signing-key': { configKey: 'signingKey', required: true, previousKeyConfigKey: 'previousSigningKey' },
 * }
 * ```
 */
export interface SecretMapping {
  /** Key in the final AppConfig object (or nested path like "stellar.signingKey"). */
  configKey: string;
  /** For rotation: the config key that holds the previous version during the overlap window. */
  previousKeyConfigKey?: string;
  /** How long to accept the previous key after rotation (ms). Default 5 minutes. */
  rotationOverlapMs?: number;
}

/** Event emitted when a secret rotates. */
export const SECRET_ROTATED_EVENT = "secret.rotated";

/** Event emitted when a secret fails to load (provider error). */
export const SECRET_ERROR_EVENT = "secret.error";