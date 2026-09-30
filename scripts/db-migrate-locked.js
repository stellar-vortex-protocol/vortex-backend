#!/usr/bin/env node
/**
 * scripts/db-migrate-locked.js — the single entrypoint for *every* automated
 * `prisma migrate deploy` against a shared database (issue #497).
 *
 * Why this exists
 * ---------------
 * `npm run db:migrate:prod` is idempotent but not serialised: two CD runs
 * (a push to main and a tag build, two environments, a re-run while a previous
 * run is still migrating) would otherwise interleave DDL. This wrapper makes
 * "one migration at a time per database" a property of the *database*, not of
 * the orchestrator:
 *
 *   1. Acquire a PostgreSQL session advisory lock with a BOUNDED wait. The lock
 *      lives in Postgres, so it also serialises runners GitHub Actions cannot
 *      see (manual `kubectl run`, a second cluster, a re-run from a different
 *      ref). On timeout we fail closed instead of migrating anyway.
 *   2. Record a pre-migration checkpoint row in `_migration_checkpoints`
 *      (timestamp + current schema version + git SHA + job name) *before*
 *      touching the schema, so rollback always has a "state at" marker even
 *      when no `pg_dump` was taken (see RUNBOOK_BACKUP_RESTORE.md).
 *   3. Run `prisma migrate deploy` (or an explicit command after `--`) while
 *      still holding the lock.
 *   4. Record the outcome (`succeeded`/`failed`), release the lock, and exit
 *      with the migration's exit code. A non-zero exit fails the CD `migrate`
 *      job, which halts the rollout because `staging`/`production` need it.
 *
 * Runs inside the Kubernetes Job rendered from `deploy/k8s/migration-job.yaml`
 * by `.github/workflows/cd.yml`, i.e. with the exact image digest that is about
 * to be rolled out — "the image that deploys is the image that migrates".
 *
 * Why plain JavaScript (not TypeScript)
 * -------------------------------------
 * The Job runs the *runtime* image (production `npm ci --omit=dev`), which has
 * neither `tsx` nor a build step for `scripts/`. `pg` is a production
 * dependency, so this file uses nothing that is not already in the runtime
 * image. Helpers are exported so `scripts/db-migrate-locked.spec.ts` can unit
 * test them without a live Postgres.
 *
 * Environment
 * -----------
 *   DATABASE_URL                 required. The DIRECT (non-pooler) connection
 *                                string: Prisma's schema only declares
 *                                `url = env("DATABASE_URL")` (no `directUrl`),
 *                                so the Job must hand the primary's URL to
 *                                `migrate deploy` — migrations must never go
 *                                through a transaction pooler.
 *   MIGRATION_LOCK_KEY           advisory-lock object id (int4). Default 1.
 *   MIGRATION_LOCK_WAIT_SECONDS  bounded wait for the lock. Default 600.
 *   MIGRATION_GIT_SHA            recorded in the checkpoint row.
 *   MIGRATION_JOB_NAME           recorded in the checkpoint row (Job/run name).
 *
 * Usage
 * -----
 *   node scripts/db-migrate-locked.js            # run `prisma migrate deploy`
 *   node scripts/db-migrate-locked.js -- cmd ... # run a specific command
 *   node scripts/db-migrate-locked.js --help
 */
"use strict";

const { spawn } = require("child_process");
const { existsSync, readFileSync } = require("fs");
const path = require("path");

/** Advisory-lock class id: ASCII "VXMG" (VorTeX Migrations). int4 range. */
const MIGRATION_LOCK_CLASS_ID = 0x56584d47;

/** Table that records one row per migration attempt (pre/post phase). */
const CHECKPOINT_TABLE = "_migration_checkpoints";

const CHECKPOINT_DDL = `
CREATE TABLE IF NOT EXISTS "${CHECKPOINT_TABLE}" (
  id            BIGSERIAL PRIMARY KEY,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_name      TEXT NOT NULL,
  git_sha       TEXT,
  schema_version TEXT,
  phase         TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
  status        TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  detail        TEXT
)`;

const DEFAULT_LOCK_WAIT_SECONDS = 600;
const LOCK_RETRY_INTERVAL_MS = 2000;

function usage() {
  return [
    "Usage: node scripts/db-migrate-locked.js [--help] [-- command ...]",
    "",
    "Acquires a bounded PostgreSQL advisory lock, writes a pre-migration",
    `checkpoint row to ${CHECKPOINT_TABLE}, runs the migration command while`,
    "holding the lock, records the outcome, releases the lock, and exits with",
    "the command's exit code.",
    "",
    "With no command, runs `prisma migrate deploy` from the local install",
    "(falling back to a version-pinned `npx prisma@<package.json pin>` so the",
    "job can never fetch an arbitrary `latest` CLI at migration time).",
  ].join("\n");
}

/**
 * argv parsing. Everything after `--` is the command to run; `--help` prints
 * usage. Kept tiny and pure so the spec can cover it.
 */
function parseArgs(argv) {
  const opts = { help: false, command: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      opts.help = true;
    } else if (argv[i] === "--") {
      opts.command = argv.slice(i + 1);
      break;
    } else {
      throw new Error(`unrecognised argument: ${argv[i]} (try --help)`);
    }
  }
  if (opts.command !== null && opts.command.length === 0) {
    throw new Error("`--` must be followed by a command");
  }
  return opts;
}

/** Parse an int4 with a range check — Postgres rejects anything wider. */
function parseInt4(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
    throw new Error(`${name} must be a 32-bit integer, got "${value}"`);
  }
  return n;
}

/** Advisory-lock object id from MIGRATION_LOCK_KEY (default 1). */
function lockObjectId(env) {
  return parseInt4(env.MIGRATION_LOCK_KEY || "1", "MIGRATION_LOCK_KEY");
}

/** Bounded lock wait from MIGRATION_LOCK_WAIT_SECONDS (default 600). */
function lockWaitSeconds(env) {
  const n = Number(env.MIGRATION_LOCK_WAIT_SECONDS || String(DEFAULT_LOCK_WAIT_SECONDS));
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw new Error(
      `MIGRATION_LOCK_WAIT_SECONDS must be an integer in [1, 3600], got "${env.MIGRATION_LOCK_WAIT_SECONDS}"`,
    );
  }
  return n;
}

/**
 * Where the Prisma CLI lives in this image.
 *
 * The runtime image installs the CLI at the version pinned in package.json
 * (see the Dockerfile), so `node <cli> migrate deploy` is the normal path. The
 * `npx --yes prisma@<pin>` fallback exists for dev machines / images built
 * before that Dockerfile change: an unpinned `npx prisma` would silently pull
 * `latest`, which is a *different major* Prisma version than the one that
 * generated these migrations — exactly the misordered-tools outage this issue
 * exists to prevent.
 */
function resolveMigrateCommand(rootDir, pkg, fsExists = existsSync) {
  const cli = path.join(rootDir, "node_modules", "prisma", "build", "index.js");
  const version = (pkg.devDependencies && pkg.devDependencies.prisma) || (pkg.dependencies && pkg.dependencies.prisma);
  if (fsExists(cli)) {
    return [process.execPath, cli, "migrate", "deploy"];
  }
  if (!version) {
    throw new Error("prisma CLI not found in node_modules and no version pinned in package.json");
  }
  return ["npx", "--yes", `prisma@${version}`, "migrate", "deploy"];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  // Single-line, timestamped: this lands in `kubectl logs` and is what the
  // CD job prints when the Job fails.
  console.log(`[db-migrate-locked] ${new Date().toISOString()} ${message}`);
}

/**
 * Best-effort description of who currently holds our advisory lock, so a
 * timeout tells the operator *what* is blocking instead of just "timed out".
 */
async function describeLockHolder(client, classId, objectId) {
  try {
    const res = await client.query(
      `SELECT l.pid, l.granted, a.state, a.query_start, a.query
         FROM pg_locks l
         LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = $1::int4 AND l.objid = $2::int4`,
      [classId, objectId],
    );
    if (res.rows.length === 0) return "the lock was released while we waited";
    return res.rows
      .map((r) => `pid=${r.pid} granted=${r.granted} state=${r.state} since=${r.query_start}`)
      .join("; ");
  } catch (err) {
    return `lock holder unknown (diagnostic query failed: ${err.message})`;
  }
}

/** Prisma's own migration bookkeeping table (may not exist on a fresh DB). */
const CHECKPOINT_VERSION_TABLE = "public._prisma_migrations";

/** True when `_prisma_migrations` exists (i.e. this database was migrated before). */
async function schemaVersion(client) {
  const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [CHECKPOINT_VERSION_TABLE]);
  if (!exists.rows[0].ok) return "empty-schema";
  try {
    const res = await client.query(
      `SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
    );
    return res.rows.length > 0 ? res.rows[0].migration_name : "empty-schema";
  } catch {
    // Table exists but is unreadable (permissions) — still record something.
    return "unknown";
  }
}

async function insertCheckpoint(client, { phase, status, jobName, gitSha, version, detail }) {
  await client.query(CHECKPOINT_DDL);
  await client.query(
    `INSERT INTO "${CHECKPOINT_TABLE}"
       (job_name, git_sha, schema_version, phase, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jobName, gitSha, version, phase, status, detail],
  );
}

/**
 * Spawn the migration command. Returns both the handle (so the advisory-lock
 * connection can kill it if the lock is lost mid-run) and a promise for the
 * exit status.
 */
function runCommand(command) {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  const done = new Promise((resolve) => {
    child.on("error", (err) => resolve({ code: 127, error: err }));
    child.on("exit", (code, signal) => resolve({ code: code === null ? 1 : code, signal }));
  });
  return { child, done };
}

async function main(argv, env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. The migration Job must receive the DIRECT (non-pooler) " +
        "connection string from the GitHub Environment secret MIGRATION_DATABASE_URL.",
    );
  }
  // Never let a URL with credentials reach the log line below.
  const redactedUrl = databaseUrl.replace(/:[^:@/]+@/, ":***@");

  const rootDir = path.join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const command = opts.command || resolveMigrateCommand(rootDir, pkg);
  const classId = MIGRATION_LOCK_CLASS_ID;
  const objectId = lockObjectId(env);
  const waitSeconds = lockWaitSeconds(env);
  const jobName = env.MIGRATION_JOB_NAME || "local";
  const gitSha = env.MIGRATION_GIT_SHA || null;

  const { Client } = require("pg");
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15000,
  });

  let childRunning = false;
  // Handle to the in-flight migration command (wired up in step 3).
  let childRef = null;
  // If our lock connection dies while the migration is running, Postgres drops
  // the session lock and a *second* migrator could start DDL concurrently. The
  // only safe reaction is to stop the migration we control; the checkpoint row
  // records the attempt as failed for the operator. (Any other failure path
  // exits the process, and closing this session is what releases the lock.)
  client.on("error", (err) => {
    log(`FATAL: lock connection lost (${err.message}); stopping the in-flight migration`);
    if (childRunning && childRef) {
      childRef.kill("SIGTERM");
    }
  });

  await client.connect();
  log(`connected to ${redactedUrl} (lock class=${classId} object=${objectId}, wait=${waitSeconds}s)`);

  // ── 1. Bounded advisory lock ────────────────────────────────────────────
  const deadline = Date.now() + waitSeconds * 1000;
  let locked = false;
  for (;;) {
    const res = await client.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked", [
      classId,
      objectId,
    ]);
    if (res.rows[0].locked) {
      locked = true;
      break;
    }
    if (Date.now() >= deadline) {
      const holder = await describeLockHolder(client, classId, objectId);
      throw new Error(
        `another migration holds the advisory lock after ${waitSeconds}s — refusing to run ` +
          `concurrently. Holder(s): ${holder}. If that migration is stuck, resolve it first; ` +
          `do not force a second one.`,
      );
    }
    log("waiting for the migration advisory lock held by another run …");
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
  log("advisory lock acquired");

  // ── 2. Pre-migration checkpoint (recorded before any DDL) ───────────────
  const versionBefore = await schemaVersion(client);
  try {
    await insertCheckpoint(client, {
      phase: "pre",
      status: "started",
      jobName,
      gitSha,
      version: versionBefore,
      detail: `command: ${command.join(" ")}`,
    });
  } catch (err) {
    throw new Error(
      `cannot record the pre-migration checkpoint in ${CHECKPOINT_TABLE}: ${err.message}. ` +
        "Failing closed — a migration without a rollback marker is not an acceptable state.",
    );
  }
  log(`checkpoint recorded (schema_version=${versionBefore})`);

  // ── 3. Migrate, still holding the lock ──────────────────────────────────
  log(`running: ${command.join(" ")}`);
  const spawned = runCommand(command);
  childRef = spawned.child;
  childRunning = true;
  const result = await spawned.done;
  childRunning = false;
  const status = result.code === 0 ? "succeeded" : "failed";
  const detail =
    result.code === 0
      ? `command exited 0`
      : `command exited ${result.code}${result.signal ? ` (signal ${result.signal})` : ""}`;

  // ── 4. Record the outcome, release the lock ─────────────────────────────
  try {
    await insertCheckpoint(client, {
      phase: "post",
      status,
      jobName,
      gitSha,
      version: await schemaVersion(client),
      detail,
    });
  } catch (err) {
    // A failure to record must not mask the migration's own exit code, but it
    // must be loud: the checkpoint table is part of the rollback contract.
    log(`WARNING: could not record the post-migration checkpoint: ${err.message}`);
  }

  try {
    await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [classId, objectId]);
    log("advisory lock released");
  } catch (err) {
    log(`WARNING: could not release the advisory lock explicitly (${err.message}); closing the connection releases it`);
  }

  await client.end();
  log(`migration ${status} (${detail})`);
  return result.code;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      // `::error::` is a GitHub Actions annotation; inside the Job it simply
      // prefixes the kubectl-log line, and the CD job re-emits it from there.
      console.error(`::error::${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  CHECKPOINT_DDL,
  CHECKPOINT_TABLE,
  MIGRATION_LOCK_CLASS_ID,
  lockObjectId,
  lockWaitSeconds,
  parseArgs,
  parseInt4,
  resolveMigrateCommand,
  usage,
};
