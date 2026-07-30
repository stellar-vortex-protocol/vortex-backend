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
