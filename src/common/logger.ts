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

export const logger = createLogger({
  level: resolveLogLevel(),
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`),
  ),
  transports: [new transports.Console()],
});
