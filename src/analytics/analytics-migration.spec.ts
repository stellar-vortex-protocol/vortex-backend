import * as fs from "fs";
import * as path from "path";

/**
 * Static checks for the chain-pair / slippage migration (issues #593, #594).
 * A live TimescaleDB is not available to the unit suite, so this pins the
 * properties that matter for existing data: the new columns are additive with
 * a safe default, the new aggregates materialise existing rows, and the four
 * original aggregates are left alone.
 */
const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const DIR = path.join(
  MIGRATIONS,
  "20261020000000_analytics_chain_pair_slippage",
);
const up = fs.readFileSync(path.join(DIR, "migration.sql"), "utf8");
const down = fs.readFileSync(path.join(DIR, "down.sql"), "utf8");
const sqlOnly = (sql: string) => sql.replace(/--.*$/gm, "");

describe("analytics chain-pair / slippage migration", () => {
  it("adds dst_chain with an 'unknown' default so pre-migration rows stay valid", () => {
    expect(up).toMatch(
      /ADD COLUMN IF NOT EXISTS "dst_chain" TEXT NOT NULL DEFAULT 'unknown'/,
    );
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS "quoted_dst_amount" NUMERIC;/);
  });

  it.each(["1m", "1h", "1d"])(
    "creates analytics_fills_chain_pair_%s as a continuous aggregate",
    (interval) => {
      expect(up).toMatch(
        new RegExp(
          `CREATE MATERIALIZED VIEW "analytics_fills_chain_pair_${interval}"\\s+WITH \\(timescaledb\\.continuous\\)`,
        ),
      );
      expect(up).toContain(
        `add_continuous_aggregate_policy('analytics_fills_chain_pair_${interval}'`,
      );
    },
  );

  it("backfills the new aggregates from existing rows (no WITH NO DATA)", () => {
    expect(sqlOnly(up)).not.toMatch(/WITH NO DATA/i);
  });

  it("does not touch the existing analytics_fills_{1m,1h,1d} aggregates", () => {
    expect(sqlOnly(up)).not.toMatch(
      /(DROP|ALTER)\s+MATERIALIZED VIEW\s+(IF EXISTS\s+)?"analytics_fills_(1m|1h|1d)"/i,
    );
    expect(sqlOnly(down)).not.toMatch(/"analytics_fills_(1m|1h|1d)"/);
  });

  it("down.sql drops everything the forward migration created", () => {
    for (const view of ["1m", "1h", "1d"]) {
      expect(down).toContain(
        `DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_chain_pair_${view}"`,
      );
    }
    expect(down).toContain(`DROP COLUMN IF EXISTS "dst_chain"`);
    expect(down).toContain(`DROP COLUMN IF EXISTS "quoted_dst_amount"`);
  });
});
