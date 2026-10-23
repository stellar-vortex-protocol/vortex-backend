/**
 * Archival configuration resolved from AppConfig (#413).
 */
export interface ArchivalConfig {
  /** Whether the daily archival job is enabled. */
  enabled: boolean;
  /** S3 bucket to write Parquet files and the manifest into. */
  bucketName: string;
  /** S3-compatible endpoint URL. Empty = AWS S3 default endpoint. */
  endpoint: string;
  /** AWS region. */
  region: string;
  /** AWS / MinIO access key ID. */
  accessKeyId: string;
  /** AWS / MinIO secret access key. */
  secretAccessKey: string;
  /**
   * Terminal intents (filled / cancelled / expired / slashed) older than
   * this many days are eligible for archival.
   */
  retentionDays: number;
  /**
   * S3 key prefix for the date partition.
   * Written as: `<partitionPrefix><YYYY-MM-DD>/`.
   * Default: `date=`.
   */
  partitionPrefix: string;
  /**
   * Maximum rows written to a single Parquet file before rotating.
   * Keeps individual files under ~256 MB.
   */
  maxRowsPerFile: number;
  /**
   * Whether the scheduled integrity re-verification job is enabled (#697).
   * Defaults to `true` when archival is enabled.
   */
  verifyEnabled: boolean;
  /**
   * Cron expression for the integrity re-verification sweep (#697).
   * Default: `0 3 * * *` (daily at 03:00, offset from the archival job).
   */
  verifyCron: string;
  /**
   * Maximum number of archived date partitions re-verified per run (#697).
   * The sweep rotates through partitions via a persisted cursor so that a
   * bucket with years of accumulated partitions is not fully re-verified on
   * every run. Default: `10`.
   */
  verifySampleSize: number;
  /**
   * S3 key used to persist the rotation cursor between verification runs
   * (#697). Default: `<partitionPrefix>_verify-cursor.json`.
   */
  verifyRotationCursorKey: string;
}

/** Default cron for the integrity re-verification sweep (#697). */
export const DEFAULT_VERIFY_CRON = '0 3 * * *';

/** Default max partitions re-verified per run (#697). */
export const DEFAULT_VERIFY_SAMPLE_SIZE = 10;

/**
 * Resolve the integrity re-verification knobs (#697) from the environment.
 *
 * Supported env vars:
 * - `ARCHIVAL_VERIFY_ENABLED` — `true`/`false`; defaults to the archival
 *   `enabled` flag when unset.
 * - `ARCHIVAL_VERIFY_CRON` — cron expression; defaults to
 *   {@link DEFAULT_VERIFY_CRON}.
 * - `ARCHIVAL_VERIFY_SAMPLE_SIZE` — positive integer; defaults to
 *   {@link DEFAULT_VERIFY_SAMPLE_SIZE}.
 * - `ARCHIVAL_VERIFY_CURSOR_KEY` — S3 key for the rotation cursor; defaults
 *   to `<partitionPrefix>_verify-cursor.json`.
 */
export function resolveVerifyConfig(
  env: Record<string, string | undefined>,
  archivalEnabled: boolean,
  partitionPrefix: string,
): Pick<
  ArchivalConfig,
  'verifyEnabled' | 'verifyCron' | 'verifySampleSize' | 'verifyRotationCursorKey'
> {
  const verifyEnabled = parseBoolean(
    env.ARCHIVAL_VERIFY_ENABLED,
    archivalEnabled,
  );

  const verifyCron =
    env.ARCHIVAL_VERIFY_CRON && env.ARCHIVAL_VERIFY_CRON.trim().length > 0
      ? env.ARCHIVAL_VERIFY_CRON.trim()
      : DEFAULT_VERIFY_CRON;

  const parsedSampleSize = Number.parseInt(
    env.ARCHIVAL_VERIFY_SAMPLE_SIZE ?? '',
    10,
  );
  const verifySampleSize =
    Number.isFinite(parsedSampleSize) && parsedSampleSize > 0
      ? parsedSampleSize
      : DEFAULT_VERIFY_SAMPLE_SIZE;

  const verifyRotationCursorKey =
    env.ARCHIVAL_VERIFY_CURSOR_KEY &&
    env.ARCHIVAL_VERIFY_CURSOR_KEY.trim().length > 0
      ? env.ARCHIVAL_VERIFY_CURSOR_KEY.trim()
      : `${partitionPrefix}_verify-cursor.json`;

  return {
    verifyEnabled,
    verifyCron,
    verifySampleSize,
    verifyRotationCursorKey,
  };
}

function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}