import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped correlation fields (issue #488).
 *
 * Every log record written while a context is active carries these fields
 * automatically, so a call site never has to thread `requestId` or `intentId`
 * through its arguments just to get it into a log line. The field names are
 * part of the documented log schema (see `docs/observability/logging.md`) —
 * dashboards and the log-based alerts in `ops/observability/loki-rules/`
 * query them by name, so treat a rename as a breaking change.
 */
export interface LogContextFields {
  /** Inbound `x-request-id`, or a generated UUID. */
  requestId?: string;
  /** OTel trace id of the request, when the caller supplied a `traceparent`. */
  traceId?: string;
  /** Intent the current unit of work is about. */
  intentId?: string;
  /** Solver address the current unit of work is about. */
  solver?: string;
  /** Chain the current unit of work is about (`stellar`, `ethereum`, ...). */
  chain?: string;
  /** Background job id, inside a queue worker. */
  jobId?: string;
}

/** The keys of {@link LogContextFields}, in schema order. */
export const LOG_CONTEXT_KEYS: readonly (keyof LogContextFields)[] = [
  "requestId",
  "traceId",
  "intentId",
  "solver",
  "chain",
  "jobId",
];

const storage = new AsyncLocalStorage<LogContextFields>();

/**
 * Run `fn` with `fields` merged over the current context.
 *
 * Nested calls inherit the outer fields, so a job that runs inside a request
 * still logs the request id. The store is a fresh object per call, so a nested
 * scope can never leak fields back into its parent.
 */
export function runWithLogContext<T>(fields: LogContextFields, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...stripUndefined(fields) }, fn);
}

/** The active context, or an empty object outside any scope. */
export function getLogContext(): Readonly<LogContextFields> {
  return storage.getStore() ?? {};
}

/**
 * Add fields to the active context in place — used once a handler learns the
 * intent or solver it is working on, after the request scope already started.
 *
 * A no-op outside a scope: there is no request to annotate, and silently
 * creating a global context would leak fields across unrelated work.
 */
export function bindLogContext(fields: LogContextFields): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, stripUndefined(fields));
}

function stripUndefined(fields: LogContextFields): LogContextFields {
  const out: LogContextFields = {};
  for (const key of LOG_CONTEXT_KEYS) {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}
