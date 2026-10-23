/**
 * Mapping between the epoch-second INTEGER columns and their timestamptz twins
 * during the issue #409 expand/contract migration.
 *
 * API payloads stay in epoch seconds throughout; only the storage changes.
 * Writes always go to both columns. Reads come from the column selected by
 * `TIMESTAMP_READ_SOURCE`:
 *
 * - `epoch` (default until the backfill is verified) — the INTEGER column.
 * - `timestamptz` — the timestamptz twin, falling back to the INTEGER column
 *   for a row the backfill has not reached yet, so flipping the switch early
 *   can never return a wrong value.
 */
export type TimestampReadSource = "epoch" | "timestamptz";

export const TIMESTAMP_READ_SOURCES: readonly TimestampReadSource[] = ["epoch", "timestamptz"];

/** Options accepted by the Prisma repositories that store epoch timestamps. */
export interface EpochTimestampOptions {
  timestampReadSource?: TimestampReadSource;
}

/** Epoch seconds → Date (UTC). */
export function epochToDate(seconds: number): Date;
export function epochToDate(seconds: number | null | undefined): Date | null;
export function epochToDate(seconds: number | null | undefined): Date | null {
  return seconds === null || seconds === undefined ? null : new Date(seconds * 1000);
}

/** Date → whole epoch seconds (floored, matching `floor(extract(epoch …))`). */
export function dateToEpoch(date: Date): number;
export function dateToEpoch(date: Date | null | undefined): number | null;
export function dateToEpoch(date: Date | null | undefined): number | null {
  return date === null || date === undefined ? null : Math.floor(date.getTime() / 1000);
}

/** Read one epoch value from the configured source, falling back to the INTEGER column. */
export function readEpoch(
  source: TimestampReadSource,
  epoch: number | null | undefined,
  ts: Date | null | undefined,
): number | null {
  if (source === "timestamptz" && ts) return dateToEpoch(ts);
  return epoch ?? null;
}
