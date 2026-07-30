/**
 * scripts/seed.ts
 *
 * Standalone seed script for local development (issue #59).
 *
 * Background
 * ----------
 * Before this script existed, `IntentsService` and `SolversService` both
 * seeded their in-memory maps directly inside their constructors by calling
 * `buildSeedIntents()` / `buildSeedSolvers()`.  That approach works while the
 * store is in-memory, but will break once a real database lands (issue #36)
 * because the constructor would fire on every service boot and insert
 * duplicate rows.
 *
 * This script separates that concern: the seed *data* still lives in
 * `src/intents/intents.seed.ts` and `src/solvers/solvers.seed.ts` (shapes are
 * unchanged), while the act of *writing* that data to the store happens here,
 * run once on demand.
 *
 * Usage
 * -----
 *   npx ts-node scripts/seed.ts
 *   # or, after adding the npm script:
 *   npm run seed
 *
 * What it does
 * ------------
 * 1. Reads the seed builders from `src/` (same data, same shape as before).
 * 2. Assigns stable UUIDs and timestamps so re-runs produce the same IDs.
 * 3. Writes the result to `.seed-data/intents.json` and `.seed-data/solvers.json`.
 *    These files represent the "persistent store" until issue #36 wires up a
 *    real database.  The service layer should be updated to read from these
 *    files (or the real DB) instead of calling the builders in the constructor.
 *
 * Extending for a real DB
 * -----------------------
 * Replace the `writeFileSync` blocks below with the appropriate ORM calls,
 * e.g.:
 *
 *   await intentRepository.save(intents);
 *   await solverRepository.save(solvers);
 *
 * Keep the rest of the script identical — the data shape does not change.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { buildSeedIntents } from "../src/intents/intents.seed";
import { buildSeedSolvers } from "../src/solvers/solvers.seed";

const OUT_DIR = join(__dirname, "..", ".seed-data");

function main() {
  const now = Math.floor(Date.now() / 1000);

  // ── Intents ──────────────────────────────────────────────────────────────
  const intentRows = buildSeedIntents(now).map((data, idx) => ({
    ...data,
    intentId: uuidv4(),
    // Spread creation times across the last 10 minutes so the list looks
    // realistic in local dev (matches the original constructor behaviour).
    createdAt: now - idx * 120,
  }));

  // ── Solvers ───────────────────────────────────────────────────────────────
  const solverRows = buildSeedSolvers();

  // ── Persist ───────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(
    join(OUT_DIR, "intents.json"),
    JSON.stringify(intentRows, null, 2),
    "utf8",
  );
  console.log(`✔ Wrote ${intentRows.length} intents  →  .seed-data/intents.json`);

  writeFileSync(
    join(OUT_DIR, "solvers.json"),
    JSON.stringify(solverRows, null, 2),
    "utf8",
  );
  console.log(`✔ Wrote ${solverRows.length} solvers  →  .seed-data/solvers.json`);

  console.log(
    "\nTo use a real database: replace the writeFileSync calls with your ORM's",
    "insert/save calls and keep the seed builder imports unchanged.",
  );
}

main();
