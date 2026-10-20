import * as Sentry from "@sentry/node";

/**
 * Initialise Sentry once at application boot.
 * When SENTRY_DSN is absent (local dev / CI) this is a no-op — every
 * Sentry API call is safe to make regardless because the SDK guards internally.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Capture 100 % of transactions in non-production, 10 % in production
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });
}

/**
 * Report an unexpected error to Sentry.
 * Safe to call even when Sentry was not initialised — returns undefined quietly.
 */
export function captureException(err: unknown): void {
  Sentry.captureException(err);
}

/** Context attached to an operator alert raised through {@link captureAlert}. */
export interface AlertContext {
  /** Indexed Sentry tags (low-cardinality strings). */
  tags?: Record<string, string>;
  /** Free-form structured detail shown on the event. */
  extra?: Record<string, unknown>;
  /** Groups repeat alerts for the same subject into one Sentry issue. */
  fingerprint?: string[];
}

/**
 * Raise an operator alert as an `error`-level Sentry event (the level the
 * paging rules route on). Like {@link captureException} it is a quiet no-op
 * when Sentry was never initialised.
 */
export function captureAlert(message: string, ctx: AlertContext = {}): void {
  Sentry.captureMessage(message, {
    level: "error",
    tags: ctx.tags,
    extra: ctx.extra,
    fingerprint: ctx.fingerprint,
  });
}
