import * as path from "path";
import {
  checkMigration,
  checkMigrationDir,
  checkSql,
  parseSuppressions,
  splitStatements,
} from "./check-migrations";

const fixtures = (name: string) => path.join(__dirname, "__fixtures__", name);

describe("splitStatements", () => {
  it("splits on semicolons and skips blank/comment lines", () => {
    const sql = [
      "-- leading comment",
      "",
      "CREATE INDEX idx ON t (c);",
      "ALTER TABLE t ADD COLUMN x int;",
    ].join("\n");
    const statements = splitStatements(sql);
    expect(statements.map((s) => s.text)).toEqual([
      "CREATE INDEX idx ON t (c);",
      "ALTER TABLE t ADD COLUMN x int;",
    ]);
  });

  it("tracks the 1-based start line of each statement", () => {
    const sql = [
      "-- comment",
      "CREATE INDEX idx ON t (c);",
      "",
      "LOCK TABLE t;",
    ].join("\n");
    const statements = splitStatements(sql);
    expect(statements[0].startLine).toBe(2);
    expect(statements[1].startLine).toBe(4);
  });

  it("strips trailing inline comments", () => {
    const statements = splitStatements("CREATE INDEX idx ON t (c); -- note\n");
    expect(statements[0].text).toBe("CREATE INDEX idx ON t (c);");
  });
});

describe("parseSuppressions", () => {
  it("detects a justified suppression split across two lines", () => {
    const sql = "-- squawk-ignore lock-table\n-- justification: table is empty\n";
    const suppressions = parseSuppressions(sql);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].ruleId).toBe("lock-table");
    expect(suppressions[0].justified).toBe(true);
  });

  it("detects a same-line justification", () => {
    const sql = "-- squawk-ignore lock-table -- justification: table is empty\n";
    expect(parseSuppressions(sql)[0].justified).toBe(true);
  });

  it("marks a suppression without justification as unjustified", () => {
    const sql = "-- squawk-ignore lock-table\n";
    expect(parseSuppressions(sql)[0].justified).toBe(false);
  });
});

describe("checkSql — unsafe DDL rules", () => {
  it("flags CREATE INDEX without CONCURRENTLY", () => {
    const { violations } = checkSql("CREATE INDEX idx ON t (c);");
    expect(violations.map((v) => v.ruleId)).toContain("create-index-without-concurrently");
  });

  it("flags CREATE UNIQUE INDEX without CONCURRENTLY", () => {
    const { violations } = checkSql("CREATE UNIQUE INDEX idx ON t (c);");
    expect(violations.map((v) => v.ruleId)).toContain("create-index-without-concurrently");
  });

  it("does not flag CREATE INDEX CONCURRENTLY", () => {
    const { violations } = checkSql("CREATE INDEX CONCURRENTLY idx ON t (c);");
    expect(violations).toHaveLength(0);
  });

  it("flags DROP INDEX without CONCURRENTLY", () => {
    const { violations } = checkSql("DROP INDEX idx;");
    expect(violations.map((v) => v.ruleId)).toContain("drop-index-without-concurrently");
  });

  it("does not flag DROP INDEX CONCURRENTLY", () => {
    const { violations } = checkSql("DROP INDEX CONCURRENTLY idx;");
    expect(violations).toHaveLength(0);
  });

  it("flags ALTER COLUMN ... TYPE (column type rewrite)", () => {
    const { violations } = checkSql("ALTER TABLE t ALTER COLUMN c TYPE bigint;");
    expect(violations.map((v) => v.ruleId)).toContain("column-type-rewrite");
  });

  it("flags ALTER COLUMN ... SET DATA TYPE", () => {
    const { violations } = checkSql("ALTER TABLE t ALTER COLUMN c SET DATA TYPE numeric;");
    expect(violations.map((v) => v.ruleId)).toContain("column-type-rewrite");
  });

  it("flags SET NOT NULL", () => {
    const { violations } = checkSql("ALTER TABLE t ALTER COLUMN c SET NOT NULL;");
    expect(violations.map((v) => v.ruleId)).toContain("not-null-without-default");
  });

  it("flags ADD COLUMN NOT NULL without DEFAULT", () => {
    const { violations } = checkSql("ALTER TABLE t ADD COLUMN c integer NOT NULL;");
    expect(violations.map((v) => v.ruleId)).toContain("not-null-without-default");
  });

  it("does not flag ADD COLUMN NOT NULL with DEFAULT", () => {
    const { violations } = checkSql("ALTER TABLE t ADD COLUMN c integer NOT NULL DEFAULT 0;");
    expect(violations.map((v) => v.ruleId)).not.toContain("not-null-without-default");
  });

  it("flags LOCK TABLE", () => {
    const { violations } = checkSql("LOCK TABLE t IN ACCESS EXCLUSIVE MODE;");
    expect(violations.map((v) => v.ruleId)).toContain("lock-table");
  });

  it("reports the line number of the offending statement", () => {
    const sql = "-- comment\nCREATE INDEX idx ON t (c);\n";
    const { violations } = checkSql(sql);
    expect(violations[0].line).toBe(2);
  });
});

describe("checkSql — suppression", () => {
  it("suppresses a violation when a justified directive precedes it", () => {
    const sql =
      "-- squawk-ignore create-index-without-concurrently\n" +
      "-- justification: table is empty\n" +
      "CREATE INDEX idx ON t (c);\n";
    const { violations, errors } = checkSql(sql);
    expect(violations).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("rejects a suppression that lacks a justification and still reports the violation", () => {
    const sql = "-- squawk-ignore create-index-without-concurrently\nCREATE INDEX idx ON t (c);\n";
    const { violations, errors } = checkSql(sql);
    expect(errors.some((e) => e.includes("requires a"))).toBe(true);
    expect(violations.map((v) => v.ruleId)).toContain("create-index-without-concurrently");
  });

  it("only suppresses the next statement, not later ones", () => {
    const sql =
      "-- squawk-ignore create-index-without-concurrently -- justification: empty table\n" +
      "CREATE INDEX idx1 ON t (c);\n" +
      "CREATE INDEX idx2 ON t (d);\n";
    const { violations } = checkSql(sql);
    // Only the second index (idx2) should still be flagged.
    expect(violations).toHaveLength(1);
  });
});

describe("checkMigration — down.sql requirement", () => {
  it("flags a missing down.sql", () => {
    const { violations } = checkMigration("CREATE INDEX CONCURRENTLY idx ON t (c);", false);
    expect(violations.map((v) => v.ruleId)).toContain("missing-down-sql");
  });

  it("does not flag a missing down.sql when present", () => {
    const { violations } = checkMigration("CREATE INDEX CONCURRENTLY idx ON t (c);", true);
    expect(violations.map((v) => v.ruleId)).not.toContain("missing-down-sql");
  });

  it("allows suppressing the down.sql requirement with a justified directive", () => {
    const sql =
      "-- squawk-ignore missing-down-sql -- justification: one-way data migration, cannot be reversed\n" +
      "ALTER TABLE t DISABLE TRIGGER ALL;\n";
    const { violations } = checkMigration(sql, false);
    expect(violations.map((v) => v.ruleId)).not.toContain("missing-down-sql");
  });
});

describe("checkMigrationDir — fixtures", () => {
  it("passes a safe migration with a down.sql", () => {
    const { violations, errors } = checkMigrationDir(fixtures("safe"));
    expect(violations).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("flags every unsafe rule in the unsafe fixture", () => {
    const { violations } = checkMigrationDir(fixtures("unsafe"));
    const ids = violations.map((v) => v.ruleId).sort();
    expect(ids).toEqual([
      "column-type-rewrite",
      "create-index-without-concurrently",
      "lock-table",
      "not-null-without-default",
    ]);
  });

  it("flags a migration directory with no down.sql", () => {
    const { violations } = checkMigrationDir(fixtures("no-down"));
    expect(violations.map((v) => v.ruleId)).toContain("missing-down-sql");
  });

  it("passes a migration whose violations are all justified-suppressed", () => {
    const { violations, errors } = checkMigrationDir(fixtures("suppressed"));
    expect(violations).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
