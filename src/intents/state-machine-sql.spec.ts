import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { INTENT_STATES } from "./intents.types";
import {
  DB_ALLOWED_TRANSITIONS,
  findRule,
  renderAllowedPairsSql,
  requiresOverride,
  SQL_SEED_BEGIN,
  SQL_SEED_END,
} from "./state-machine";

/**
 * Issue #406 — the SQL side of the intent state machine.
 *
 * 1. Drift check (always runs): the seed embedded in the trigger migration
 *    must be byte-identical to what `renderAllowedPairsSql()` generates from
 *    TRANSITION_TABLE. Fix a failure with `npm run check:state-machine -- --write`.
 * 2. Trigger check (opt-in via TEST_DATABASE_URL, like the Prisma repository
 *    contract): every one of the |states|² `(from, to)` pairs is attempted as a
 *    real UPDATE and must succeed exactly when the TS table says so.
 */

const MIGRATIONS_DIR = join(__dirname, "../../prisma/migrations");
const MIGRATION_NAME = "intent_state_transition_trigger";

function migrationSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith(`_${MIGRATION_NAME}`));
  if (!dir) throw new Error(`migration *_${MIGRATION_NAME} not found`);
  return readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
}

function embeddedSeed(sql: string): string {
  const start = sql.indexOf(SQL_SEED_BEGIN);
  const end = sql.indexOf(SQL_SEED_END);
  if (start < 0 || end < 0) throw new Error("generated seed markers not found in migration");
  return sql.slice(start, end + SQL_SEED_END.length);
}

describe("intent_state_transitions seed (issue #406)", () => {
  it("matches the TypeScript transition table", () => {
    expect(embeddedSeed(migrationSql())).toBe(renderAllowedPairsSql());
  });

  it("seeds every non-compensation edge and nothing else", () => {
    const seeded = [...embeddedSeed(migrationSql()).matchAll(/\('(\w+)', '(\w+)', '(\w+)'\)/g)].map(
      ([, from, to, kind]) => `${from}->${to}:${kind}`,
    );
    expect(seeded.sort()).toEqual(DB_ALLOWED_TRANSITIONS.map((r) => `${r.from}->${r.to}:${r.kind}`).sort());
  });
});

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("intents_enforce_state_transition trigger (Postgres)", () => {
  let prisma: PrismaClient;
  const prefix = `sm-${Date.now()}`;
  const pairs = INTENT_STATES.flatMap((from) => INTENT_STATES.map((to) => [from, to] as const));

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM intents WHERE intent_id LIKE '${prefix}-%'`);
    await prisma.$disconnect();
  });

  async function seed(id: string, state: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO intents (id, intent_id, "user", src_chain, src_token, src_amount, dst_token,
                            min_dst_amount, state, created_at, deadline)
       VALUES ($1, $1, 'GSTATEMACHINE', 'base', '{}'::jsonb, '1', '{}'::jsonb, '1',
               $2::"IntentState", 0, 0)`,
      id,
      state,
    );
  }

  async function tryUpdate(id: string, to: string, override = false): Promise<"ok" | "rejected"> {
    try {
      await prisma.$transaction(async (tx) => {
        if (override) {
          await tx.$executeRaw`SELECT set_config('vortex.intent_state_override', 'on', true)`;
        }
        await tx.$executeRawUnsafe(
          `UPDATE intents SET state = $2::"IntentState" WHERE intent_id = $1`,
          id,
          to,
        );
      });
      return "ok";
    } catch (err) {
      if (/illegal intent state transition/.test((err as Error).message)) return "rejected";
      throw err;
    }
  }

  it(`enforces all ${INTENT_STATES.length ** 2} (from, to) pairs exactly like the TS table`, async () => {
    const mismatches: string[] = [];
    for (const [from, to] of pairs) {
      const id = `${prefix}-${from}-${to}`;
      await seed(id, from);
      const rule = findRule(from, to);
      // Same-state updates never fire the trigger (WHEN OLD.state IS DISTINCT FROM NEW.state).
      const expected = from === to || (rule !== undefined && !requiresOverride(rule)) ? "ok" : "rejected";
      const actual = await tryUpdate(id, to);
      if (actual !== expected) mismatches.push(`${from} -> ${to}: expected ${expected}, got ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("lets compensation edges through only with the transaction-local override", async () => {
    for (const to of ["filled", "expired"]) {
      const id = `${prefix}-comp-${to}`;
      await seed(id, "slashed");
      expect(await tryUpdate(id, to)).toBe("rejected");
      expect(await tryUpdate(id, to, true)).toBe("ok");
    }
  });

  it("does not leak the override past its transaction", async () => {
    const id = `${prefix}-leak`;
    await seed(id, "filled");
    // An override transaction may make any change…
    expect(await tryUpdate(id, "expired", true)).toBe("ok");
    // …but the next transaction (possibly on the same pooled connection) is guarded again.
    expect(await tryUpdate(id, "open")).toBe("rejected");
  });
});
