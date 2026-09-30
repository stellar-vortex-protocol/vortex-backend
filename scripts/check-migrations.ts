/**
 * scripts/check-migrations.ts
 *
 * Migration linter for the public protocol. A self-contained "squawk-equivalent"
 * that flags unsafe DDL in migrations a change adds or modifies, and enforces
 * that every such migration ships a `down.sql`.
 *
 * It is invoked by the `migration-lint` CI job (see .github/workflows/ci.yml)
 * as `npm run check:migrations -- --base <sha>`. Only migrations changed between
 * `<base>...HEAD` are linted, so older migrations can never fail retroactively.
 *
 * Rules (see prisma/migrations/README.md):
 *   - create-index-without-concurrently  CREATE [UNIQUE] INDEX missing CONCURRENTLY
 *   - drop-index-without-concurrently    DROP INDEX missing CONCURRENTLY
 *   - column-type-rewrite                ALTER COLUMN ... TYPE / SET DATA TYPE
 *   - not-null-without-default           SET NOT NULL, or ADD COLUMN NOT NULL w/o DEFAULT
 *   - lock-table                         LOCK TABLE
 *   - missing-down-sql                   migration directory has no down.sql
 *
 * Suppression: a `-- squawk-ignore <rule>` comment above a statement suppresses
 * that rule for the next statement. It MUST be paired with a
 * `-- justification: <reason>` comment (same line or the line below), otherwise
 * the override is rejected. `missing-down-sql` is suppressed the same way, with
 * the directive placed at the top of `migration.sql`.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── types ───────────────────────────────────────────────────────────────────

export interface Violation {
  ruleId: string;
  message: string;
  /** 1-based line of the offending statement (or 1 for directory-level rules). */
  line: number;
}

export interface MigrationResult {
  violations: Violation[];
  errors: string[];
}

export interface Rule {
  id: string;
  description: string;
  matches: (statement: string) => boolean;
}

interface Statement {
  text: string;
  startLine: number;
}

interface Suppression {
  ruleId: string;
  line: number;
  justified: boolean;
}

// ── rules ───────────────────────────────────────────────────────────────────

export const RULES: Rule[] = [
  {
    id: "create-index-without-concurrently",
    description:
      "CREATE INDEX / CREATE UNIQUE INDEX should use CONCURRENTLY to avoid blocking writes on a hot table",
    matches: (s) => /CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s),
  },
  {
    id: "drop-index-without-concurrently",
    description: "DROP INDEX should use CONCURRENTLY to avoid blocking writes",
    matches: (s) => /\bDROP\s+INDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s),
  },
  {
    id: "column-type-rewrite",
    description:
      "ALTER COLUMN ... TYPE / SET DATA TYPE rewrites the whole table under an ACCESS EXCLUSIVE lock",
    matches: (s) => /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i.test(s),
  },
  {
    id: "not-null-without-default",
    description:
      "Adding NOT NULL without a DEFAULT fails on existing NULL rows and takes a strong lock",
    matches: (s) => {
      const setNotNull = /\bSET\s+NOT\s+NULL\b/i.test(s);
      const addColumnNotNullNoDefault =
        /\bADD\s+COLUMN\b/i.test(s) && /\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s);
      return setNotNull || addColumnNotNullNoDefault;
    },
  },
  {
    id: "lock-table",
    description: "LOCK TABLE takes an explicit table lock that blocks concurrent access",
    matches: (s) => /\bLOCK\s+TABLE\b/i.test(s),
  },
];

export const MISSING_DOWN_SQL_RULE = "missing-down-sql";

const SUPPRESSION_PATTERN = /--\s*squawk-ignore\s+([a-zA-Z0-9-]+)/;
const JUSTIFICATION_PATTERN = /--\s*justification\s*:/i;

// ── SQL tokenisation & suppression parsing ──────────────────────────────────

/**
 * Split raw SQL into statements, tracking the 1-based line each statement
 * starts on. Comment-only and blank lines are skipped; trailing inline
 * `--` comments are stripped so they can't cause false positives.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  const lines = sql.split("\n");
  let buf: string[] = [];
  let startLine = 0;

  const flush = () => {
    const text = buf.join(" ").trim();
    if (text) statements.push({ text, startLine });
    buf = [];
    startLine = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].trim().split("--")[0].trim();

    if (code === "" && buf.length === 0) continue; // leading blank/comment line
    if (buf.length === 0 && code !== "") startLine = i + 1;
    if (code !== "") buf.push(code);
    if (code.endsWith(";")) flush();
  }

  flush(); // trailing statement without a terminating ';'
  return statements;
}

/** Extract `-- squawk-ignore <rule>` directives and whether each is justified. */
export function parseSuppressions(sql: string): Suppression[] {
  const lines = sql.split("\n");
  const suppressions: Suppression[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SUPPRESSION_PATTERN);
    if (!match) continue;
    const sameLine = JUSTIFICATION_PATTERN.test(lines[i]);
    const nextLine = JUSTIFICATION_PATTERN.test(lines[i + 1] ?? "");
    suppressions.push({ ruleId: match[1], line: i + 1, justified: sameLine || nextLine });
  }

  return suppressions;
}

/** Map each justified suppression to the rule ids it suppresses on the next statement. */
function suppressedRuleIds(statements: Statement[], suppressions: Suppression[]): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const suppression of suppressions) {
    if (!suppression.justified) continue;
    const next = statements.find((s) => s.startLine > suppression.line);
    if (!next) continue;
    if (!map.has(next.startLine)) map.set(next.startLine, new Set());
    map.get(next.startLine)!.add(suppression.ruleId);
  }
  return map;
}

function hasSuppressionFor(sql: string, ruleId: string): boolean {
  return parseSuppressions(sql).some((s) => s.ruleId === ruleId && s.justified);
}

// ── checks ──────────────────────────────────────────────────────────────────

/** Lint a single migration.sql body for unsafe DDL, honouring suppressions. */
export function checkSql(sql: string): MigrationResult {
  const violations: Violation[] = [];
  const errors: string[] = [];

  const suppressions = parseSuppressions(sql);
  for (const suppression of suppressions) {
    if (!suppression.justified) {
      errors.push(
        `-- squawk-ignore ${suppression.ruleId} at line ${suppression.line} requires a "-- justification:" comment`,
      );
    }
  }

  const statements = splitStatements(sql);
  const suppressed = suppressedRuleIds(statements, suppressions);

  for (const statement of statements) {
    const blocked = suppressed.get(statement.startLine) ?? new Set<string>();
    for (const rule of RULES) {
      if (blocked.has(rule.id)) continue;
      if (rule.matches(statement.text)) {
        violations.push({ ruleId: rule.id, message: rule.description, line: statement.startLine });
      }
    }
  }

  return { violations, errors };
}

/** Lint a migration given its SQL and whether it has a down.sql. */
export function checkMigration(sql: string, hasDownSql: boolean): MigrationResult {
  const violations: Violation[] = [];
  const errors: string[] = [];

  if (!hasDownSql && !hasSuppressionFor(sql, MISSING_DOWN_SQL_RULE)) {
    violations.push({
      ruleId: MISSING_DOWN_SQL_RULE,
      message: "Migration directory must include a down.sql for rollback",
      line: 1,
    });
  }

  const result = checkSql(sql);
  violations.push(...result.violations);
  errors.push(...result.errors);
  return { violations, errors };
}

/** Read and lint a migration directory (containing migration.sql + optional down.sql). */
export function checkMigrationDir(dirPath: string): MigrationResult {
  const migrationPath = path.join(dirPath, "migration.sql");
  const downPath = path.join(dirPath, "down.sql");

  let sql: string;
  try {
    sql = fs.readFileSync(migrationPath, "utf8");
  } catch {
    return { violations: [], errors: [`Missing migration.sql in ${dirPath}`] };
  }

  return checkMigration(sql, fs.existsSync(downPath));
}

// ── changed-migration discovery & CLI ───────────────────────────────────────

/** Migration directories changed between `base...HEAD`. */
export function changedMigrationDirs(base: string): string[] {
  const output = execSync(`git diff --name-only ${base}...HEAD -- prisma/migrations`, {
    encoding: "utf8",
  });
  const dirs = new Set<string>();
  for (const file of output.split("\n").map((f) => f.trim()).filter(Boolean)) {
    const match = file.match(/^prisma\/migrations\/([^/]+)\//);
    if (match) dirs.add(path.join("prisma", "migrations", match[1]));
  }
  return [...dirs].sort();
}

function parseArgs(argv: string[]): { base: string } {
  let base = "HEAD^1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) {
      base = argv[i + 1];
      i++;
    }
  }
  return { base };
}

function main(): void {
  const { base } = parseArgs(process.argv.slice(2));

  let dirs: string[];
  try {
    dirs = changedMigrationDirs(base);
  } catch (err) {
    console.error(`Failed to compute changed migrations against base "${base}": ${(err as Error).message}`);
    process.exit(1);
  }

  if (dirs.length === 0) {
    console.log("No changed migrations to lint.");
    return;
  }

  let failed = false;
  for (const dir of dirs) {
    const result = checkMigrationDir(dir);
    for (const violation of result.violations) {
      console.error(`${dir}/migration.sql:${violation.line}: ${violation.ruleId} — ${violation.message}`);
      failed = true;
    }
    for (const error of result.errors) {
      console.error(`${dir}: ${error}`);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      "\nMigration lint failed. Fix the violations or suppress with " +
        "`-- squawk-ignore <rule>` plus a `-- justification:` (see prisma/migrations/README.md).",
    );
    process.exit(1);
  }

  console.log(`Linted ${dirs.length} changed migration(s) — no unsafe DDL or missing down.sql.`);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require.main === module) {
  main();
}
