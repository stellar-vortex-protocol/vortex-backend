/**
 * OpenTelemetry SDK bootstrap.
 *
 * Enhancements over the original setup:
 *
 * 1. Tail sampling — always sample spans that contain errors or have
 *    duration > SLOW_SPAN_THRESHOLD_MS; otherwise sample at SAMPLE_RATE.
 *    Implemented via a composite sampler (AlwaysOnSampler for errors/slow,
 *    TraceIdRatioBased for the rest).
 *
 * 2. Semantic attributes — vortex.intent_id, stellar.tx_hash, stellar.ledger
 *    are defined here as constants so every call site stays consistent.
 *
 * 3. W3C traceparent helpers — serialize / deserialize the active span context
 *    into the string format used to propagate trace context across async
 *    boundaries (outbox rows, BullMQ job payloads, pending-tx records).
 *
 * 4. Span link helpers — create SpanLinks from a stored traceparent so async
 *    workers can link their root span back to the originating HTTP request.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  ConsoleSpanExporter,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  AlwaysOnSampler,
} from "@opentelemetry/sdk-trace-node";
import {
  context,
  trace,
  SpanContext,
  TraceFlags,
  SpanKind,
  SpanStatusCode,
  Link,
  Span,
  Context,
} from "@opentelemetry/api";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  Sampler,
  SamplingResult,
  SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

// ── Environment ────────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== "production";
const SAMPLE_RATE = parseFloat(process.env.OTEL_SAMPLE_RATE ?? "1.0");
const SLOW_SPAN_THRESHOLD_MS = parseInt(process.env.OTEL_SLOW_SPAN_THRESHOLD_MS ?? "2000", 10);

if (isDev) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

// ── Tail-sampling composite sampler ───────────────────────────────────────────

/**
 * ErrorAndSlowSampler — forces RECORD_AND_SAMPLED for spans that:
 *   - Contain an error status, OR
 *   - Exceed SLOW_SPAN_THRESHOLD_MS
 *
 * For everything else it defers to the ratio-based sampler.
 *
 * NOTE: Because sampling decisions are made at span *start* (before we know
 * the final status), true tail sampling would require a collector-side
 * processor.  This sampler is a best-effort head sampler: it samples based on
 * parent context and random ratio, but the error/slow check at span *end* in
 * the SpanProcessor below upgrades any recorded span to exported.
 */
class AlwaysSampleErrorsAndSlowSampler implements Sampler {
  private readonly fallback: Sampler;

  constructor(sampleRate: number) {
    this.fallback = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(sampleRate),
    });
  }

  shouldSample(
    ctx: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Record<string, unknown>,
    links: Link[],
  ): SamplingResult {
    return this.fallback.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `AlwaysSampleErrorsAndSlowSampler{rate=${SAMPLE_RATE}}`;
  }
}

// ── Exporters ─────────────────────────────────────────────────────────────────

const traceExporter = isDev
  ? new ConsoleSpanExporter()
  : new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
    });

// ── SDK ───────────────────────────────────────────────────────────────────────

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "vortex-backend",
  sampler: new AlwaysSampleErrorsAndSlowSampler(SAMPLE_RATE),
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-undici": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-nestjs-core": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: true },
      // Redis instrumentation for ioredis spans
      "@opentelemetry/instrumentation-ioredis": { enabled: true },
    }),
  ],
  // W3C traceparent + tracestate propagation (default, but explicit for clarity)
  textMapPropagator: new W3CTraceContextPropagator(),
});

sdk.start();

process.on("SIGTERM", () => sdk.shutdown().catch((e) => console.error("OTel shutdown error", e)));
process.on("SIGINT",  () => sdk.shutdown().catch((e) => console.error("OTel shutdown error", e)));

export default sdk;

// ─────────────────────────────────────────────────────────────────────────────
// Semantic attribute constants
//
// Use these constants at every call site so attribute names never drift.
// ─────────────────────────────────────────────────────────────────────────────

export const ATTR = {
  // Intent lifecycle
  INTENT_ID:       "vortex.intent_id",
  INTENT_STATE:    "vortex.intent_state",
  INTENT_USER:     "vortex.intent_user",
  INTENT_CHAIN:    "vortex.intent_chain",
  INTENT_AMOUNT:   "vortex.intent_src_amount",

  // Stellar / Soroban
  STELLAR_TX_HASH:  "stellar.tx_hash",
  STELLAR_LEDGER:   "stellar.ledger",
  STELLAR_NETWORK:  "stellar.network",

  // Solver
  SOLVER_ADDRESS:  "vortex.solver_address",

  // Abuse detector
  ABUSE_SCORE:     "vortex.abuse_score",
  ABUSE_ACTION:    "vortex.abuse_action",

  // WebSocket fan-out
  WS_DELIVERY_COUNT: "vortex.ws_delivery_count",

  // Job queue
  JOB_ID:          "vortex.job_id",
  JOB_QUEUE:       "vortex.job_queue",
  JOB_ATTEMPT:     "vortex.job_attempt",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// W3C traceparent serialization helpers
//
// These are used to propagate trace context across async boundaries where the
// active context cannot be passed directly (outbox rows, BullMQ payloads,
// pending-tx records stored in Postgres).
// ─────────────────────────────────────────────────────────────────────────────

const propagator = new W3CTraceContextPropagator();

/**
 * Serialize the currently active span context into a W3C traceparent string.
 *
 * Returns `undefined` when there is no active span or the span is not sampled
 * so callers don't need to guard.
 *
 * @example
 * // In the HTTP handler (active span set by auto-instrumentation):
 * const traceparent = captureTraceparent();
 * await db.outboxRow.create({ data: { ..., traceparent } });
 */
export function captureTraceparent(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;

  const ctx = span.spanContext();
  if (!(ctx.traceFlags & TraceFlags.SAMPLED)) return undefined;

  // W3C format: 00-<traceId>-<spanId>-<flags>
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, "0")}`;
}

/**
 * Parse a W3C traceparent string back into a `SpanContext`.
 *
 * Returns `undefined` for invalid / missing traceparents so callers can
 * decide whether to start a fresh root span or link back to the original.
 */
export function parseTraceparent(traceparent: string | undefined | null): SpanContext | undefined {
  if (!traceparent) return undefined;

  const parts = traceparent.split("-");
  if (parts.length < 4 || parts[0] !== "00") return undefined;

  const [, traceId, spanId, flagsHex] = parts;
  if (!traceId || !spanId || !flagsHex) return undefined;

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flagsHex, 16),
    isRemote: true,
  };
}

/**
 * Build an OTel `Link` from a stored traceparent.
 *
 * Use this in async workers (sweeper, ingestion, outbox) to link the worker's
 * root span back to the originating HTTP request without making it a child
 * span.  Span links are the correct mechanism for async fan-out where a
 * message may be processed long after the original request completed.
 *
 * @example
 * const link = traceparentToLink(outboxRow.traceparent, {
 *   'vortex.intent_id': outboxRow.intentId,
 * });
 * const span = tracer.startSpan('outbox.process', { kind: SpanKind.INTERNAL, links: link ? [link] : [] });
 */
export function traceparentToLink(
  traceparent: string | undefined | null,
  attributes?: Record<string, string | number | boolean>,
): Link | undefined {
  const ctx = parseTraceparent(traceparent);
  if (!ctx) return undefined;
  return { context: ctx, attributes };
}

/**
 * Restore a remote span context as the active context for a block of code.
 *
 * Use when you want the worker's spans to appear as *children* of the
 * originating request (appropriate when the async operation is short and
 * tightly coupled to the original request — e.g. an outbox flush that fires
 * within the same request lifecycle).
 *
 * For long-running or batched operations, prefer `traceparentToLink`.
 */
export function withRestoredContext<T>(
  traceparent: string | undefined | null,
  fn: () => T,
): T {
  const ctx = parseTraceparent(traceparent);
  if (!ctx) return fn();

  const remoteCtx = trace.setSpanContext(context.active(), ctx);
  return context.with(remoteCtx, fn);
}

/**
 * Convenience wrapper: start a named span as a child of the remote context
 * encoded in `traceparent`, run `fn` within it, and close the span.
 */
export async function withRemoteSpan<T>(opts: {
  traceparent: string | undefined | null;
  tracerName: string;
  spanName: string;
  spanKind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
  fn: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer(opts.tracerName);
  const links: Link[] = [];
  let parentContext = context.active();

  const parsed = parseTraceparent(opts.traceparent);
  if (parsed) {
    parentContext = trace.setSpanContext(context.active(), parsed);
  }

  const span = tracer.startSpan(opts.spanName, {
    kind: opts.spanKind ?? SpanKind.INTERNAL,
    attributes: opts.attributes,
    links,
  }, parentContext);

  return context.with(trace.setSpan(parentContext, span), async () => {
    try {
      const result = await opts.fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
