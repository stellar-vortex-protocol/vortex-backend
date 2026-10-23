/**
 * Fails if the `intent_state_transitions` seed in the trigger migration has
 * drifted from TRANSITION_TABLE in src/intents/state-machine.ts (issue #406).
 *
 * Run:   tsx scripts/check-state-machine.ts           # check
 *        tsx scripts/check-state-machine.ts --write   # regenerate the seed in place
 *
 * The seed only ever changes together with a NEW migration (applied migrations
 * are immutable). When adding an edge, copy the trigger migration's seed block
 * into a new migration and point MIGRATION_NAME below at it.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAllowedPairsSql, SQL_SEED_BEGIN, SQL_SEED_END } from "../src/intents/state-machine";

const MIGRATIONS_DIR = join(__dirname, "..", "prisma", "migrations");
const MIGRATION_NAME = "intent_state_transition_trigger";

const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith(`_${MIGRATION_NAME}`));
if (!dir) {
  console.error(`✖ migration *_${MIGRATION_NAME} not found in prisma/migrations`);
  process.exit(1);
}
const file = join(MIGRATIONS_DIR, dir, "migration.sql");
const sql = readFileSync(file, "utf8");
const start = sql.indexOf(SQL_SEED_BEGIN);
const end = sql.indexOf(SQL_SEED_END);
if (start < 0 || end < 0) {
  console.error(`✖ ${file}: generated seed markers not found`);
  process.exit(1);
}

const embedded = sql.slice(start, end + SQL_SEED_END.length);
const expected = renderAllowedPairsSql();

if (embedded === expected) {
  console.log(`✓ ${dir}: intent_state_transitions seed matches src/intents/state-machine.ts`);
  process.exit(0);
}

if (process.argv.includes("--write")) {
  writeFileSync(file, sql.slice(0, start) + expected + sql.slice(end + SQL_SEED_END.length));
  console.log(`✎ ${dir}: seed regenerated from src/intents/state-machine.ts`);
  process.exit(0);
}

console.error(`✖ ${dir}: seed drifted from src/intents/state-machine.ts\n`);
console.error("--- migration\n" + embedded + "\n\n+++ expected\n" + expected + "\n");
console.error("Run `npm run check:state-machine -- --write` (in a new migration if this one is already applied).");
process.exit(1);
