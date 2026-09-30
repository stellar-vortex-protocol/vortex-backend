/**
 * Tracing helpers for async workers and job queue processors.
 *
 * This module provides a thin NestJS-injectable wrapper around the low-level
 * tracing utilities in src/tracing.ts so they can be injected via DI without
 * creating a circular dependency with the OTel SDK bootstrap.
 *
 * Usage in a worker:
 *
 *   @Inject() private readonly tracing: TracingHelpers
 *
 *   async processOutboxRow(row: OutboxRow) {
 *     await this.tracing.withLinkedSpan({
 *       traceparent: row.traceparent,
 *       spanName: 'outbox.process',
 *       attributes: { [ATTR.INTENT_ID]: row.intentId },
 *       fn: async (span) => { ... }
 *     });
 *   }
 */

import { Injectable } from "@nestjs/common";
import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  Span,
  Link,
  TraceFlags,
} from "@opentelemetry/api";
import { captureTraceparent, parseTraceparent, traceparentToLink, withRemoteSpan, ATTR } from "../tracing";

export { ATTR };

@Injectable()
export class TracingHelpers {
  private readonly tracer = trace.getTracer("vortex-backend");

  /**
   * Capture the W3C traceparent of the currently active span.
   * Call this in HTTP handlers before writing to the outbox / job queue.
   */
  capture(): string | undefined {
    return captureTraceparent();
  }

  /**
   * Start a span linked (not parented) to the remote context encoded in
   * `traceparent`.  Suitable for async workers that process a message long
   * after the originating request completed.
   */
  async withLinkedSpan<T>(opts: {
    traceparent: string | undefined | null;
    spanName: string;
    spanKind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
    fn: (span: Span) => Promise<T>;
  }): Promise<T> {
    const links: Link[] = [];
    const link = traceparentToLink(opts.traceparent, opts.attributes);
    if (link) links.push(link);

    const span = this.tracer.startSpan(opts.spanName, {
      kind: opts.spanKind ?? SpanKind.INTERNAL,
      attributes: opts.attributes,
      links,
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
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

  /**
   * Start a span as a *child* of the remote context encoded in `traceparent`.
   * Use when the async operation is tightly coupled to the originating request
   * (e.g. a brief outbox flush triggered within the same request lifecycle).
   */
  async withChildSpan<T>(opts: {
    traceparent: string | undefined | null;
    spanName: string;
    spanKind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
    fn: (span: Span) => Promise<T>;
  }): Promise<T> {
    return withRemoteSpan({
      traceparent: opts.traceparent,
      tracerName: "vortex-backend",
      spanName: opts.spanName,
      spanKind: opts.spanKind,
      attributes: opts.attributes,
      fn: opts.fn,
    });
  }

  /**
   * Add trace_id and span_id fields to a structured log object so logs can be
   * correlated with traces in Grafana / Tempo.
   */
  enrichLogContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const span = trace.getActiveSpan();
    if (!span) return extra;
    const ctx = span.spanContext();
    if (!(ctx.traceFlags & TraceFlags.SAMPLED)) return extra;
    return { ...extra, trace_id: ctx.traceId, span_id: ctx.spanId };
  }
}
