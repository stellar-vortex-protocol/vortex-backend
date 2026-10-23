/**
 * Redaction helpers for the admin runtime-configuration endpoint.
 *
 * The denylist below is the single source of truth for which `AppConfig`
 * fields must never be exposed over the wire. A companion test asserts that
 * every `AppConfig` field whose name looks secret-shaped (see
 * `SECRET_SHAPED_FIELD_PATTERN`) is present in the denylist, so a newly-added
 * secret field cannot silently leak.
 */

import { AppConfig } from "./configuration";

/**
 * Heuristic for "this field name probably holds a secret".
 *
 * Mirrors the convention used by `src/soroban/redaction.ts` so we do not end
 * up with two competing redaction conventions in the codebase.
 */
export const SECRET_SHAPED_FIELD_PATTERN = /key|secret|token|password/i;

/** Marker substituted for any redacted value. */
export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_PLACEHOLDER = REDACTED_VALUE;

export function isSecretShapedField(field: string): boolean {
  const leaf = field.split(".").pop() ?? field;
  return SECRET_SHAPED_FIELD_PATTERN.test(leaf);
}

/**
 * Explicit denylist of `AppConfig` field names that must be redacted.
 *
 * Keep this in sync with `AppConfig`: the redaction test fails CI if a
 * secret-shaped field is missing here.
 */
export const CONFIG_REDACTED_FIELDS: ReadonlyArray<string> = [
  // Connection strings / credentials
  "databaseUrl",
  "redisUrl",
  "rateLimitRedisUrl",
  "killswitch.redisUrl",

  // AppConfig actual secret-shaped fields
  "stellar.signerSecretKey",
  "stellar.signingKey",
  "stellar.channelSecretKeys",
  "abuse.captcha.secret",
  "killswitch.operatorToken",
  "adminApiKeys",
  "datasets.webhookSecret",
  "authJwtSecret",
  "sep10JwtSigningKey",
  "ttlKeeper.intentKeyVariant",
  "ttlKeeper.bondKeyVariant",
  "archival.accessKeyId",
  "archival.secretAccessKey",

  // Nested secrets bag
  "secrets.extra",
];

export const REDACTED_CONFIG_FIELDS: ReadonlyArray<string> = CONFIG_REDACTED_FIELDS;

const REDACTED_FIELD_SET: ReadonlySet<string> = new Set(CONFIG_REDACTED_FIELDS);

/** Returns true if the given (possibly dotted) config path is denylisted. */
export function isRedactedConfigField(path: string, customSet: ReadonlySet<string> = REDACTED_FIELD_SET): boolean {
  return customSet.has(path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function redactValue(value: unknown, path: string, customSet: ReadonlySet<string>): unknown {
  if (isRedactedConfigField(path, customSet)) {
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, customSet));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = redactValue(child, childPath, customSet);
    }
    return result;
  }

  return value;
}

export interface RedactConfigOptions {
  fields?: ReadonlyArray<string>;
}

/**
 * Returns a deep copy of `config` with every denylisted field replaced by
 * `REDACTED_VALUE`. The input object is never mutated.
 */
export function redactConfig(config: AppConfig, options?: RedactConfigOptions): Record<string, unknown> {
  const customSet = options?.fields ? new Set(options.fields) : REDACTED_FIELD_SET;
  const redacted = redactValue(config, "", customSet);
  return redacted as Record<string, unknown>;
}
