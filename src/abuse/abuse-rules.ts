/**
 * Runtime-tunable abuse rule configuration (issue #603).
 *
 * Precedence, highest first:
 *   1. persisted overrides  — set via `PATCH /api/v1/abuse/rules/:signal`,
 *                             stored as one JSON blob at `vortex:abuse:config`
 *   2. env overrides        — `ABUSE_<RULE>_*` (see AbuseScoreService)
 *   3. DEFAULT_ABUSE_RULES
 *
 * Overrides are sparse: only the fields an operator changed are stored, so a
 * later env change to an untouched field still takes effect.
 */

import Redis from "ioredis";
import { AbuseRulesConfig, AbuseSignal, DEFAULT_ABUSE_RULES } from "./abuse.types";

/** Redis key holding the persisted overrides blob. */
export const ABUSE_RULES_REDIS_KEY = "vortex:abuse:config";

/** DI token for the overrides store. */
export const ABUSE_RULES_STORE = Symbol("ABUSE_RULES_STORE");

export const ABUSE_SIGNALS = Object.keys(DEFAULT_ABUSE_RULES) as AbuseSignal[];

/** A tunable rule field value: `enabled` is boolean, every other field a number. */
export type RuleFieldValue = boolean | number;

/** Sparse per-rule overrides. */
export type AbuseRuleOverrides = Partial<Record<AbuseSignal, Record<string, RuleFieldValue>>>;

/** Persistence for the overrides blob. */
export interface AbuseRulesStore {
  load(): Promise<AbuseRuleOverrides>;
  /**
   * Atomically read-modify-write the overrides. `mutate` receives the current
   * persisted value and returns the next one. Concurrent updates must not
   * interleave: each one sees the result of the one before it.
   */
  update(mutate: (current: AbuseRuleOverrides) => AbuseRuleOverrides): Promise<AbuseRuleOverrides>;
}

export class AbuseRuleValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

export function isAbuseSignal(value: string): value is AbuseSignal {
  return (ABUSE_SIGNALS as string[]).includes(value);
}

/** Fields whose value must stay within [0, 1]. */
const RATIO_FIELDS = new Set(["minCancelRatio"]);

/**
 * Validate a PATCH body for one rule. Only fields that already exist on the
 * rule are accepted; `enabled` must be a boolean and every other field a
 * finite, non-negative number. Throws {@link AbuseRuleValidationError}.
 */
export function validateRulePatch(signal: AbuseSignal, body: unknown): Record<string, RuleFieldValue> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AbuseRuleValidationError(["body must be a JSON object"]);
  }
  const allowed = Object.keys(DEFAULT_ABUSE_RULES[signal]);
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) {
    throw new AbuseRuleValidationError([`body must set at least one of: ${allowed.join(", ")}`]);
  }

  const problems: string[] = [];
  const patch: Record<string, RuleFieldValue> = {};
  for (const [field, value] of entries) {
    const problem = fieldProblem(signal, field, value);
    if (problem) problems.push(problem);
    else patch[field] = value as RuleFieldValue;
  }
  if (problems.length > 0) throw new AbuseRuleValidationError(problems);
  return patch;
}

function fieldProblem(signal: AbuseSignal, field: string, value: unknown): string | null {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_ABUSE_RULES[signal], field)) {
    return `unknown field "${field}" for rule ${signal}`;
  }
  if (field === "enabled") {
    return typeof value === "boolean" ? null : `"enabled" must be a boolean`;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `"${field}" must be a non-negative number`;
  }
  if (RATIO_FIELDS.has(field) && value > 1) {
    return `"${field}" must be between 0 and 1`;
  }
  return null;
}

/**
 * Keep only well-formed overrides. A blob edited by hand or written by an
 * older version must never be able to break the scorer, so invalid fields
 * are dropped rather than rejected.
 */
export function sanitizeOverrides(raw: unknown): AbuseRuleOverrides {
  const clean: AbuseRuleOverrides = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return clean;
  for (const [signal, fields] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAbuseSignal(signal) || fields === null || typeof fields !== "object") continue;
    const kept: Record<string, RuleFieldValue> = {};
    for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
      if (fieldProblem(signal, field, value) === null) kept[field] = value as RuleFieldValue;
    }
    if (Object.keys(kept).length > 0) clean[signal] = kept;
  }
  return clean;
}

/** Layer persisted overrides on top of the env/default config. */
export function mergeRules(base: AbuseRulesConfig, overrides: AbuseRuleOverrides): AbuseRulesConfig {
  const merged = structuredClone(base);
  for (const signal of ABUSE_SIGNALS) {
    const fields = overrides[signal];
    if (fields) Object.assign(merged[signal], fields);
  }
  return merged;
}

/** Process-local store for tests and single-process dev. */
export class InMemoryAbuseRulesStore implements AbuseRulesStore {
  private value: AbuseRuleOverrides = {};
  private queue: Promise<unknown> = Promise.resolve();

  async load(): Promise<AbuseRuleOverrides> {
    return structuredClone(this.value);
  }

  update(mutate: (current: AbuseRuleOverrides) => AbuseRuleOverrides): Promise<AbuseRuleOverrides> {
    const run = this.queue.then(() => {
      this.value = sanitizeOverrides(mutate(structuredClone(this.value)));
      return structuredClone(this.value);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * Redis store. Updates use WATCH/MULTI optimistic locking so two operators on
 * different instances cannot lose each other's change; updates from one
 * instance are additionally queued in-process because EXEC on a shared
 * connection clears every WATCH on it.
 */
export class RedisAbuseRulesStore implements AbuseRulesStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly redis: Redis,
    private readonly maxAttempts = 5,
  ) {}

  async load(): Promise<AbuseRuleOverrides> {
    await this.ensureConnected();
    return parse(await this.redis.get(ABUSE_RULES_REDIS_KEY));
  }

  update(mutate: (current: AbuseRuleOverrides) => AbuseRuleOverrides): Promise<AbuseRuleOverrides> {
    const run = this.queue.then(() => this.updateOnce(mutate));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async updateOnce(
    mutate: (current: AbuseRuleOverrides) => AbuseRuleOverrides,
  ): Promise<AbuseRuleOverrides> {
    await this.ensureConnected();
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      await this.redis.watch(ABUSE_RULES_REDIS_KEY);
      let next: AbuseRuleOverrides;
      try {
        next = sanitizeOverrides(mutate(parse(await this.redis.get(ABUSE_RULES_REDIS_KEY))));
      } catch (err) {
        await this.redis.unwatch();
        throw err;
      }
      // exec() resolves to null when the watched key changed underneath us.
      const result = await this.redis.multi().set(ABUSE_RULES_REDIS_KEY, JSON.stringify(next)).exec();
      if (result !== null) return next;
    }
    throw new Error("abuse rule update conflicted with concurrent writers; retry");
  }

  /** The client is created lazily with the offline queue off, so connect explicitly. */
  private async ensureConnected(): Promise<void> {
    if (this.redis.status === "wait") await this.redis.connect();
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

function parse(raw: string | null): AbuseRuleOverrides {
  if (!raw) return {};
  try {
    return sanitizeOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}
