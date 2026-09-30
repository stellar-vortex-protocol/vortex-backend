/**
 * scripts/db-migrate-locked.spec.ts
 *
 * Unit tests for the migration entrypoint's pure helpers (issue #497). The
 * lock/checkpoint/migrate sequence itself needs a live Postgres and is proved
 * by the CD `migrate` job; what is proved *here* is everything that decides
 * *how* that sequence behaves: bounded-wait validation, lock-key parsing, the
 * version-pinned Prisma invocation (an unpinned `npx prisma` would fetch a
 * different major version at migration time), and argv handling.
 *
 * The module is plain CommonJS JavaScript — the Kubernetes Job runs the
 * production image, which has no tsx/compiler — so it is loaded through
 * `require` and typed here instead of via an ES import (no allowJs in
 * tsconfig, and the runtime must not depend on generated types).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migrate = require("./db-migrate-locked.js") as {
  CHECKPOINT_DDL: string;
  CHECKPOINT_TABLE: string;
  MIGRATION_LOCK_CLASS_ID: number;
  lockObjectId: (env: Record<string, string | undefined>) => number;
  lockWaitSeconds: (env: Record<string, string | undefined>) => number;
  parseArgs: (argv: string[]) => { help: boolean; command: string[] | null };
  parseInt4: (value: string, name: string) => number;
  resolveMigrateCommand: (
    rootDir: string,
    pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> },
    fsExists?: (p: string) => boolean,
  ) => string[];
};

describe("db-migrate-locked helpers", () => {
  describe("parseArgs", () => {
    it("defaults to no explicit command", () => {
      expect(migrate.parseArgs([])).toEqual({ help: false, command: null });
    });

    it("treats everything after -- as the command", () => {
      expect(migrate.parseArgs(["--", "npx", "prisma", "migrate", "deploy"])).toEqual({
        help: false,
        command: ["npx", "prisma", "migrate", "deploy"],
      });
    });

    it("recognises --help", () => {
      expect(migrate.parseArgs(["--help"]).help).toBe(true);
      expect(migrate.parseArgs(["-h"]).help).toBe(true);
    });

    it("rejects unknown arguments instead of silently ignoring them", () => {
      expect(() => migrate.parseArgs(["--force"])).toThrow(/unrecognised argument/);
      expect(() => migrate.parseArgs(["--"])).toThrow(/followed by a command/);
    });
  });

  describe("int4 validation", () => {
    it("accepts the int4 range used by pg_try_advisory_lock(int, int)", () => {
      expect(migrate.parseInt4("1", "x")).toBe(1);
      expect(migrate.parseInt4("-2147483648", "x")).toBe(-2147483648);
      expect(migrate.parseInt4("2147483647", "x")).toBe(2147483647);
    });

    it("rejects non-integers and out-of-range values", () => {
      expect(() => migrate.parseInt4("abc", "x")).toThrow(/32-bit integer/);
      expect(() => migrate.parseInt4("2147483648", "x")).toThrow(/32-bit integer/);
      expect(() => migrate.parseInt4("1.5", "x")).toThrow(/32-bit integer/);
    });
  });

  describe("lock configuration", () => {
    it("defaults to object id 1 and a 600s bounded wait", () => {
      expect(migrate.lockObjectId({})).toBe(1);
      expect(migrate.lockWaitSeconds({})).toBe(600);
    });

    it("honours overrides", () => {
      expect(migrate.lockObjectId({ MIGRATION_LOCK_KEY: "42" })).toBe(42);
      expect(migrate.lockWaitSeconds({ MIGRATION_LOCK_WAIT_SECONDS: "30" })).toBe(30);
    });

    it("fails closed on a nonsensical wait instead of waiting forever", () => {
      expect(() => migrate.lockWaitSeconds({ MIGRATION_LOCK_WAIT_SECONDS: "0" })).toThrow(
        /MIGRATION_LOCK_WAIT_SECONDS/,
      );
      expect(() => migrate.lockWaitSeconds({ MIGRATION_LOCK_WAIT_SECONDS: "soon" })).toThrow(
        /MIGRATION_LOCK_WAIT_SECONDS/,
      );
      expect(() => migrate.lockWaitSeconds({ MIGRATION_LOCK_WAIT_SECONDS: "99999" })).toThrow(
        /MIGRATION_LOCK_WAIT_SECONDS/,
      );
    });

    it("keeps the lock class id inside the int4 range Postgres accepts", () => {
      expect(migrate.MIGRATION_LOCK_CLASS_ID).toBeLessThanOrEqual(2147483647);
      expect(migrate.MIGRATION_LOCK_CLASS_ID).toBeGreaterThanOrEqual(-2147483648);
    });
  });

  describe("resolveMigrateCommand", () => {
    const pkg = { devDependencies: { prisma: "5.22.0" } };

    it("uses the CLI bundled in the image when present", () => {
      const cmd = migrate.resolveMigrateCommand("/app", pkg, () => true);
      expect(cmd).toEqual([process.execPath, expect.stringContaining("prisma"), "migrate", "deploy"]);
    });

    it("pins the npx fallback to package.json's Prisma version, never `latest`", () => {
      const cmd = migrate.resolveMigrateCommand("/app", pkg, () => false);
      expect(cmd).toEqual(["npx", "--yes", "prisma@5.22.0", "migrate", "deploy"]);
    });

    it("refuses to guess a version when the CLI and the pin are both missing", () => {
      expect(() => migrate.resolveMigrateCommand("/app", {}, () => false)).toThrow(
        /no version pinned/,
      );
    });
  });

  describe("checkpoint table", () => {
    it("uses Prisma's reserved-prefix convention so the app never maps it", () => {
      expect(migrate.CHECKPOINT_TABLE).toBe("_migration_checkpoints");
      expect(migrate.CHECKPOINT_DDL).toContain('"_migration_checkpoints"');
      // The DDL must be idempotent: the Job re-runs on every deploy.
      expect(migrate.CHECKPOINT_DDL).toContain("CREATE TABLE IF NOT EXISTS");
    });

    it("constrains phase/status so a partial row cannot be misread", () => {
      expect(migrate.CHECKPOINT_DDL).toContain("phase IN ('pre', 'post')");
      expect(migrate.CHECKPOINT_DDL).toContain("status IN ('started', 'succeeded', 'failed')");
      expect(migrate.CHECKPOINT_DDL).toContain("schema_version TEXT");
    });
  });
});
