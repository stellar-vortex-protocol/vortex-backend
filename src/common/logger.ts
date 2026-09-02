import { createLogger, format, transports } from "winston";

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

/** Field names redacted from shipped logs — never send key material or secrets to a third-party sink. */
const SENSITIVE_FIELDS = [
  "signingKey",
  "secretKey",
  "secret",
  "privateKey",
  "password",
  "authorization",
  "token",
];

const REDACTED = "[REDACTED]";

function redactSensitiveFields(info: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...info };
  for (const field of SENSITIVE_FIELDS) {
    if (field in redacted) redacted[field] = REDACTED;
  }
  return redacted;
}

const redactFormat = format((info) => redactSensitiveFields(info) as ReturnType<typeof format>)();

/**
 * Log-shipping transport, gated behind LOG_SHIPPING_ENABLED so local dev/CI
 * remain stdout-only. Ships structured JSON (requestId, level, timestamp,
 * service) to LOG_SHIPPING_HOST:LOG_SHIPPING_PORT over HTTP.
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
    format: format.combine(format.timestamp(), redactFormat, format.json()),
  });

  transport.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[logger] log shipping transport error, dropping log: ${err.message}`);
  });

  return transport;
}

const shippingTransport = buildShippingTransport();

export const logger = createLogger({
  level: resolveLogLevel(),
  defaultMeta: {
    service: process.env.LOG_SERVICE_NAME ?? "vortex-backend",
  },
  format: format.combine(
    format.timestamp(),
    redactFormat,
    format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`),
  ),
  transports: [new transports.Console(), ...(shippingTransport ? [shippingTransport] : [])],
});
