import { LOG_CONTEXT_KEYS, LogContextFields } from "./log-context";

/**
 * Structured log schema (issue #488).
 *
 * Every record the service writes — on stdout in `LOG_FORMAT=json` and on the
 * shipping transport — is one JSON object with this shape:
 *
 * | Field           | Type    | Always | Meaning                                              |
 * |-----------------|---------|--------|------------------------------------------------------|
 * | `timestamp`     | string  | yes    | ISO-8601 UTC                                         |
 * | `level`         | string  | yes    | `error` `warn` `info` `http` `verbose` `debug` `silly` |
 * | `message`       | string  | yes    | Constant, human-readable summary. No interpolated ids |
 * | `service`       | string  | yes    | `LOG_SERVICE_NAME`                                   |
 * | `schemaVersion` | number  | yes    | {@link LOG_SCHEMA_VERSION}                           |
 * | `component`     | string  | no     | Emitting class / module, e.g. `IntentsService`       |
 * | `event`         | string  | no     | Stable dotted event name, e.g. `security.signature_failure` |
 * | `requestId`     | string  | no     | From the request context                             |
 * | `traceId`       | string  | no     | OTel trace id (32 hex)                               |
 * | `spanId`        | string  | no     | OTel span id (16 hex)                                |
 * | `intentId`      | string  | no     | Intent the record is about                           |
 * | `solver`        | string  | no     | Solver address the record is about                   |
 * | `chain`         | string  | no     | Chain the record is about                            |
 * | `jobId`         | string  | no     | Background job id                                    |
 * | `durationMs`    | number  | no     | Elapsed time of the logged operation                 |
 * | `err`           | object  | no     | `{ name, message, stack? }`                          |
 *
 * Any other field is allowed but must be camelCase and JSON-serialisable.
 * `docs/observability/logging.md` is the operator-facing copy of this table.
 */
export const LOG_SCHEMA_VERSION = 1;

/** Fields the logger owns. A call site that passes one gets it renamed to `<key>_`. */
export const RESERVED_LOG_KEYS = ["timestamp", "level", "message", "service", "schemaVersion"] as const;

/** Winston's npm levels, in severity order. */
export const LOG_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;

/**
 * Stable event names that the log-based alerts (`ops/observability/loki-rules/`)
 * key on. Use these constants rather than string literals so a typo cannot
 * silently blind an alert.
 */
export const LOG_EVENTS = {
  /** An Ed25519 / EVM signature over a protocol message did not verify. */
  SIGNATURE_FAILURE: "security.signature_failure",
  /** The signer policy denied a transaction before it was signed. */
  SIGNER_POLICY_VIOLATION: "security.signer_policy_violation",
  /** An admin request was rejected for a missing / invalid / under-privileged key. */
  ADMIN_AUTH_FAILURE: "security.admin_auth_failure",
  /** A privileged operator action was recorded to the admin audit log. */
  ADMIN_ACTION: "admin.action",
  /** One HTTP request completed. */
  HTTP_REQUEST: "http.request",
  /** An intent changed lifecycle state. */
  INTENT_TRANSITION: "intent.transition",
  /** A webhook delivery attempt finished. */
  WEBHOOK_DELIVERY: "webhook.delivery",
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

type LogPrimitive = string | number | boolean | null | undefined;

/** A value a structured field may hold. Errors are serialised by the logger. */
export type LogValue = LogPrimitive | Error | LogValue[] | { [key: string]: LogValue };

/** Schema fields with a fixed meaning. */
export interface StandardLogFields extends LogContextFields {
  /** Stable event name; prefer a {@link LOG_EVENTS} constant. */
  event?: LogEvent | string;
  /** Overrides the logger's component for one record. */
  component?: string;
  spanId?: string;
  durationMs?: number;
  /** The error being reported. Serialised to `{ name, message, stack }`. */
  err?: unknown;
}

/**
 * Fields accepted by the structured logger API: the standard schema fields
 * plus any camelCase, JSON-serialisable extras.
 */
export type LogFields = StandardLogFields & { [key: string]: LogValue | unknown };

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const EVENT_NAME = /^[a-z]+(\.[a-z][a-z0-9_]*)+$/;
const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;
const MAX_DEPTH = 6;

/** `{ name, message, stack }` for an Error; a string description for anything else thrown. */
export function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { name: "NonError", message: typeof err === "string" ? err : safeString(err) };
}

/** Convert `snake_case` / `kebab-case` / `PascalCase` keys to camelCase. */
export function toCamelKey(key: string): string {
  const parts = key.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "field";
  const joined = parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
  return /^[a-z]/.test(joined) ? joined : `f${joined}`;
}

/**
 * Normalise call-site fields into schema-conformant ones: camelCase keys,
 * reserved keys renamed, errors serialised, `undefined` dropped, cycles and
 * non-plain objects flattened to strings.
 */
export function normalizeLogFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined) continue;
    let key = CAMEL_CASE.test(rawKey) ? rawKey : toCamelKey(rawKey);
    if ((RESERVED_LOG_KEYS as readonly string[]).includes(key)) key = `${key}_`;
    out[key] = key === "err" ? normalizeErr(rawValue) : toJsonValue(rawValue, 0, new WeakSet());
  }
  return out;
}

/** An already-serialised `{ name, message }` passes through; anything else is serialised. */
function normalizeErr(value: unknown): unknown {
  if (value && typeof value === "object" && !(value instanceof Error)) {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.message === "string") {
      return {
        name: typeof candidate.name === "string" ? candidate.name : "Error",
        message: candidate.message,
        ...(typeof candidate.stack === "string" ? { stack: candidate.stack } : {}),
      };
    }
  }
  return serializeError(value);
}

function toJsonValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return safeString(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = toJsonValue(v, depth + 1, seen);
  }
  return out;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[Unserialisable]";
  }
}

/**
 * Schema-conformance check for one emitted record. Returns a list of
 * problems — empty means the record conforms. Used by the conformance tests
 * and safe to call on any parsed log line.
 */
export function validateLogRecord(record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const req = (key: string, ok: boolean, expected: string) => {
    if (!ok) problems.push(`${key}: expected ${expected}, got ${JSON.stringify(record[key])}`);
  };

  req("timestamp", typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)), "ISO-8601 string");
  req("level", (LOG_LEVELS as readonly unknown[]).includes(record.level), `one of ${LOG_LEVELS.join("|")}`);
  req("message", typeof record.message === "string" && record.message.length > 0, "non-empty string");
  req("service", typeof record.service === "string" && record.service.length > 0, "non-empty string");
  req("schemaVersion", record.schemaVersion === LOG_SCHEMA_VERSION, `${LOG_SCHEMA_VERSION}`);

  for (const key of [...LOG_CONTEXT_KEYS, "component", "spanId"]) {
    if (key in record) req(key, typeof record[key] === "string", "string");
  }
  if ("event" in record) req("event", typeof record.event === "string" && EVENT_NAME.test(record.event), "dotted lowercase event name");
  if ("traceId" in record) req("traceId", typeof record.traceId === "string" && HEX_TRACE_ID.test(record.traceId), "32 hex chars");
  if ("spanId" in record) req("spanId", typeof record.spanId === "string" && HEX_SPAN_ID.test(record.spanId), "16 hex chars");
  if ("durationMs" in record) req("durationMs", typeof record.durationMs === "number" && record.durationMs >= 0, "non-negative number");
  if ("err" in record) {
    const err = record.err as Record<string, unknown> | null;
    req("err", !!err && typeof err === "object" && typeof err.name === "string" && typeof err.message === "string", "{ name, message }");
  }

  for (const key of Object.keys(record)) {
    if (!CAMEL_CASE.test(key) && !key.endsWith("_")) problems.push(`${key}: field names must be camelCase`);
  }
  try {
    JSON.stringify(record);
  } catch (err) {
    problems.push(`record is not JSON-serialisable: ${(err as Error).message}`);
  }
  return problems;
}
