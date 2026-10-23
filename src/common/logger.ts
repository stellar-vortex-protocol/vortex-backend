import type { LoggerService } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { createLogger as createWinstonLogger, format, Logger as WinstonLogger, transports } from "winston";
import { getLogContext } from "./log-context";
import { LOG_SCHEMA_VERSION, LogFields, normalizeLogFields } from "./log-schema";

/**
 * Resolve the active log level.
 *
 * Priority order:
 *  1. LOG_LEVEL env var (explicit override, works in any environment)
 *  2. NODE_ENV heuristic  — "info" in production, "debug" everywhere else
 */
export function resolveLogLevel(): string {
  const explicit = process.env.LOG_LEVEL;
  if (explicit) return explicit;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * Resolve the console output format (issue #488).
 *
 * `json` writes one schema-conformant JSON object per line — what the OTel
 * collector in `ops/otel-collector/` parses. `pretty` keeps the human-readable
 * single-line format for local development. Defaults to `json` in production.
 */
export function resolveLogFormat(): "json" | "pretty" {
  const explicit = process.env.LOG_FORMAT?.toLowerCase();
  if (explicit === "json" || explicit === "pretty") return explicit;
  return process.env.NODE_ENV === "production" ? "json" : "pretty";
}

/** Field names redacted from every log record — never send key material or secrets to a sink. */
const SENSITIVE_FIELDS = [
  "signingKey",
  "secretKey",
  "secret",
  "privateKey",
  "password",
  "authorization",
  "token",
  "apiKey",
  "signature",
];
const SENSITIVE = new Set(SENSITIVE_FIELDS.map((f) => f.toLowerCase()));

const REDACTED = "[REDACTED]";
const MAX_REDACT_DEPTH = 6;

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.has(key.toLowerCase()) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/**
 * Redact sensitive fields at any nesting depth. Winston's info object carries
 * Symbol-keyed bookkeeping (`Symbol(level)`, `Symbol(message)`), so the top
 * level is mutated in place rather than rebuilt.
 */
function redactSensitiveFields(info: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(info)) {
    if (SENSITIVE.has(key.toLowerCase())) info[key] = REDACTED;
    else info[key] = redactValue(info[key], 1);
  }
  return info;
}

const redactFormat = format((info) => redactSensitiveFields(info as Record<string, unknown>) as never)();

/**
 * Stamp schema fields onto every record: the schema version, the
 * request-scoped context (requestId / intentId / solver / chain / jobId) and
 * the active OTel span. Explicit call-site fields win over the context.
 */
const contextFormat = format((info) => {
  const record = info as Record<string, unknown>;
  record.schemaVersion = LOG_SCHEMA_VERSION;
  const ctx = getLogContext();
  for (const [key, value] of Object.entries(ctx)) {
    if (record[key] === undefined) record[key] = value;
  }
  if (record.traceId === undefined) {
    const span = trace.getActiveSpan()?.spanContext();
    if (span && span.traceId && !/^0+$/.test(span.traceId)) {
      record.traceId = span.traceId;
      if (record.spanId === undefined) record.spanId = span.spanId;
    }
  }
  if (typeof record.message !== "string") record.message = String(record.message ?? "");
  return info;
})();

/** Human-readable line: `ts [level] (component) message key=value ...`. */
const prettyFormat = format.printf((info) => {
  const { timestamp, level, message, component, service: _service, schemaVersion: _v, ...rest } =
    info as Record<string, unknown>;
  const extras = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const prefix = component ? `(${String(component)}) ` : "";
  return `${String(timestamp)} [${String(level)}] ${prefix}${String(message)}${extras ? ` ${extras}` : ""}`;
});

/**
 * Log-shipping transport, gated behind LOG_SHIPPING_ENABLED so local dev/CI
 * remain stdout-only. Ships structured JSON (the full schema record) to
 * LOG_SHIPPING_HOST:LOG_SHIPPING_PORT over HTTP.
 *
 * Fails safe: if the sink is unreachable, winston's Http transport emits an
 * "error" event rather than throwing — we log a local warning and continue,
 * so request handling is never blocked or crashed by a shipping failure.
 */
function buildShippingTransport(): InstanceType<typeof transports.Http> | undefined {
  if (process.env.LOG_SHIPPING_ENABLED !== "true") return undefined;

  const host = process.env.LOG_SHIPPING_HOST;
  const port = process.env.LOG_SHIPPING_PORT ? Number(process.env.LOG_SHIPPING_PORT) : undefined;
  if (!host || !port) return undefined;

  const transport = new transports.Http({
    host,
    port,
    path: process.env.LOG_SHIPPING_PATH ?? "/",
    ssl: process.env.LOG_SHIPPING_SSL === "true",
    format: format.combine(format.timestamp(), contextFormat, redactFormat, format.json()),
  });

  transport.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[logger] log shipping transport error, dropping log: ${err.message}`);
  });

  return transport;
}

const shippingTransport = buildShippingTransport();

/**
 * The process-wide winston logger. Prefer {@link createLogger} at call sites —
 * it enforces the `(message, fields)` shape. This instance stays exported for
 * the transports, the Nest adapter and legacy callers.
 */
export const logger: WinstonLogger = createWinstonLogger({
  level: resolveLogLevel(),
  defaultMeta: {
    service: process.env.LOG_SERVICE_NAME ?? "vortex-backend",
  },
  format: format.combine(
    format.timestamp(),
    contextFormat,
    redactFormat,
    resolveLogFormat() === "json" ? format.json() : prettyFormat,
  ),
  transports: [new transports.Console(), ...(shippingTransport ? [shippingTransport] : [])],
});

type Level = "error" | "warn" | "info" | "debug" | "verbose";

/**
 * Structured logger API (issue #488).
 *
 * Messages are constant strings; anything variable — ids, amounts, counts,
 * errors — goes in `fields` so it can be queried:
 *
 * ```ts
 * const log = createLogger("IntentsService");
 * log.info("intent registered on-chain", { intentId, txHash });
 * log.error("on-chain registration failed", { intentId, err });
 * ```
 */
export interface StructuredLogger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  verbose(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record it writes. */
  child(fields: LogFields): StructuredLogger;
}

class ComponentLogger implements StructuredLogger {
  constructor(
    private readonly component: string,
    private readonly bound: Record<string, unknown> = {},
    private readonly base: WinstonLogger = logger,
  ) {}

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }
  verbose(message: string, fields?: LogFields): void {
    this.write("verbose", message, fields);
  }

  child(fields: LogFields): StructuredLogger {
    return new ComponentLogger(this.component, { ...this.bound, ...normalizeLogFields(fields) }, this.base);
  }

  private write(level: Level, message: string, fields?: LogFields): void {
    // Skip normalisation entirely for records the level filter would drop —
    // debug logging on a hot path must cost a level check, nothing more.
    if (!this.base.isLevelEnabled(level)) return;
    this.base.log(level, message, {
      component: this.component,
      ...this.bound,
      ...normalizeLogFields(fields),
    });
  }
}

/**
 * A structured logger for one component. `component` lands in every record
 * so log queries can be scoped to a class or module.
 */
export function createLogger(component: string, fields?: LogFields): StructuredLogger {
  return new ComponentLogger(component, normalizeLogFields(fields));
}

/**
 * Routes Nest's `Logger` (used by `new Logger(Foo.name)` across the codebase)
 * through the same winston pipeline, so framework and legacy log lines carry
 * the request context and schema fields too. Installed with
 * `app.useLogger(new NestStructuredLogger())` in `main.ts`.
 *
 * Nest calls `log(message, ...params, context)`; a trailing string is the
 * component, plain objects are merged in as fields, and a stack string on
 * `error()` becomes `err.stack`.
 */
export class NestStructuredLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params, true);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write("verbose", message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params, true);
  }

  private write(level: Level, message: unknown, params: unknown[], isError = false): void {
    if (!logger.isLevelEnabled(level)) return;
    const rest = [...params];
    let component: string | undefined;
    if (rest.length > 0 && typeof rest[rest.length - 1] === "string") component = rest.pop() as string;

    const fields: Record<string, unknown> = {};
    for (const param of rest) {
      if (param instanceof Error) fields.err = param;
      else if (param && typeof param === "object") Object.assign(fields, param);
      else if (isError && typeof param === "string") fields.err = { name: "Error", message: String(message), stack: param };
    }

    let text: string;
    if (message instanceof Error) {
      fields.err = message;
      text = message.message;
    } else if (message && typeof message === "object") {
      const { message: inner, ...objFields } = message as Record<string, unknown>;
      Object.assign(fields, objFields);
      text = typeof inner === "string" ? inner : "structured log";
    } else {
      text = String(message);
    }

    logger.log(level, text, { ...(component ? { component } : {}), ...normalizeLogFields(fields) });
  }
}
