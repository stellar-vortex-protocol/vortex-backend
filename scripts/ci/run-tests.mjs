#!/usr/bin/env node
// Runs one Jest shard in CI, with quarantine applied and a single automatic
// retry that classifies flakes (issue #486).
//
// Why a wrapper instead of plain `npm test`:
//   * `--shard` and the per-shard coverage directory have to be threaded
//     through consistently from the workflow matrix.
//   * Quarantined paths have to be ignored by both configs, and one of them is
//     JSON (test/jest-e2e.json) so it cannot do the work itself.
//   * Flake classification needs Jest's machine-readable `--json` output, i.e.
//     re-run exactly the tests that failed and diff the two runs.
//
// Exit codes: 0 = green (possibly with recorded flakes), 1 = a real failure.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { loadQuarantine, QUARANTINE_PATH, REPO_ROOT, readJson, relFromRepo } from "./lib.mjs";

const require = createRequire(import.meta.url);

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (!match) throw new Error(`unrecognised argument: ${arg}`);
  args.set(match[1], match[2] ?? "true");
}

const SUITES = {
  unit: { config: "jest.config.js", label: "Unit tests" },
  e2e: { config: "test/jest-e2e.json", label: "E2E tests" },
};

const suiteKey = args.get("suite") ?? "unit";
const suite = SUITES[suiteKey];
if (!suite) throw new Error(`--suite must be one of ${Object.keys(SUITES).join("|")}, got "${suiteKey}"`);

const shard = args.get("shard") ?? null;
if (shard !== null && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
  throw new Error(`--shard must look like 1/4, got "${shard}"`);
}

const outDir = resolve(
  REPO_ROOT,
  args.get("out-dir") ?? `ci-artifacts/${suiteKey}${shard ? `-s${shard.replace("/", "of")}` : ""}`,
);
const coverageDir = args.get("coverage-dir") ? resolve(REPO_ROOT, args.get("coverage-dir")) : null;
const resultsPath = resolve(outDir, "jest-results.json");
const retryResultsPath = resolve(outDir, "jest-retry-results.json");

const jestBin = resolve(REPO_ROOT, "node_modules", "jest", "bin", "jest.js");
if (!existsSync(jestBin)) {
  console.error(`::error::${relFromRepo(jestBin)} not found. Run "npm ci" before this script.`);
  process.exit(1);
}

const configPath = resolve(REPO_ROOT, suite.config);
const config = require(configPath);

/**
 * Quarantined paths become glob patterns of the form `**` + `/` + the
 * repo-relative path.
 *
 * Jest matches `testPathIgnorePatterns` against absolute paths, so a pattern
 * built from an absolute path would have to survive both Windows backslashes
 * (escape characters in micromatch) and the runner's checkout directory. A
 * leading `**` plus a slash avoids both.
 */
function quarantinePatterns() {
  const patterns = [...(config.testPathIgnorePatterns ?? [])];
  const { quarantined } = loadQuarantine();
  for (const entry of quarantined) {
    patterns.push(`**/${entry.path.split("\\").join("/")}`);
  }
  if (quarantined.length) {
    console.log(
      `Quarantined (skipped, tracked in ${relFromRepo(QUARANTINE_PATH)}):\n` +
        quarantined.map((e) => `  - ${e.path} (${e.owner}, ${e.issue})`).join("\n"),
    );
  }
  return patterns;
}

let patterns;
try {
  patterns = quarantinePatterns();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

const baseArgv = [
  jestBin,
  "--config",
  configPath,
  ...(shard ? ["--shard", shard] : []),
  "--json",
  "--outputFile",
  resultsPath,
];
if (coverageDir) {
  baseArgv.push(
    "--coverage",
    "--coverageDirectory",
    coverageDir,
    "--coverageReporters",
    "json",
    "--coverageReporters",
    "text-summary",
    // A shard executes a subset of the suite, so the global threshold is
    // meaningless there. jest.config.js stays the single definition of the
    // threshold; it is enforced only by scripts/ci/coverage-merge.mjs, on the
    // merged report.
    "--coverageThreshold",
    "{}",
  );
}
for (const pattern of patterns) baseArgv.push("--testPathIgnorePatterns", pattern);

const runJest = (argv) => {
  const result = spawnSync(process.execPath, argv, { cwd: REPO_ROOT, stdio: "inherit" });
  // Killed by a signal (OOM, timeout) leaves no status; treat that as failure.
  return typeof result.status === "number" ? result.status : 1;
};

const fullName = (assertion) => [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(" > ");

mkdirSync(outDir, { recursive: true });

console.log(`::group::${suite.label}${shard ? ` — shard ${shard}` : ""}`);
console.log(`jest ${baseArgv.slice(1).map((a) => (a.includes(REPO_ROOT) ? relFromRepo(a) : a)).join(" ")}`);
const firstExit = runJest(baseArgv);
console.log("::endgroup::");

let retriedFiles = [];
let retryExit = null;
let flakes = [];
let stillFailing = [];
let suiteLoadFailures = [];
let hardFailure = null;

if (firstExit !== 0) {
  if (!existsSync(resultsPath)) {
    hardFailure = `${suite.label} exited ${firstExit} without writing ${relFromRepo(resultsPath)}`;
  } else {
    const first = readJson(resultsPath);
    const failedTests = [];

    for (const suiteResult of first.testResults ?? []) {
      const failed = (suiteResult.assertionResults ?? []).filter((t) => t.status === "failed");
      if (failed.length) {
        failedTests.push(...failed.map((t) => ({ file: suiteResult.name, name: fullName(t) })));
      } else if (suiteResult.status === "failed") {
        // The file matched but produced no assertions: module-load, transform or
        // compile failure. Retrying cannot help and it is never a flake.
        suiteLoadFailures.push(suiteResult.name);
      }
    }

    if (suiteLoadFailures.length) {
      console.error(
        `::error::${suiteLoadFailures.length} test file(s) failed to load and cannot be retried:\n` +
          suiteLoadFailures.map((f) => `  - ${relFromRepo(f)}`).join("\n"),
      );
    } else if (failedTests.length === 0) {
      hardFailure = `${suite.label} exited ${firstExit} with no failing assertion recorded`;
    } else {
      retriedFiles = [...new Set(failedTests.map((t) => t.file))];
      console.log(`::group::Retrying ${failedTests.length} failed test(s) across ${retriedFiles.length} file(s)`);
      retryExit = runJest([
        jestBin,
        "--config",
        configPath,
        "--json",
        "--outputFile",
        retryResultsPath,
        // Coverage is off for the retry: the shard's report was already written
        // by the first run, and a partial re-run must not overwrite it.
        "--coverage=false",
        ...patterns.flatMap((pattern) => ["--testPathIgnorePatterns", pattern]),
        // No --shard here: the explicit paths are already exactly this shard's
        // failures, and re-applying the shard filter could select nothing.
        ...retriedFiles,
      ]);
      console.log("::endgroup::");

      const passedOnRetry = new Set();
      for (const suiteResult of existsSync(retryResultsPath) ? readJson(retryResultsPath).testResults ?? [] : []) {
        for (const assertion of suiteResult.assertionResults ?? []) {
          if (assertion.status === "passed") passedOnRetry.add(`${suiteResult.name}::${fullName(assertion)}`);
        }
      }
      flakes = failedTests.filter((t) => passedOnRetry.has(`${t.file}::${t.name}`));
      stillFailing = failedTests.filter((t) => !passedOnRetry.has(`${t.file}::${t.name}`));
    }
  }
}

const report = {
  suite: suiteKey,
  shard,
  coverageDir: coverageDir ? relFromRepo(coverageDir) : null,
  retried: retryExit !== null,
  retriedFiles: retriedFiles.map((f) => relFromRepo(f)),
  flakes: flakes.map((f) => ({ test: f.name, file: relFromRepo(f.file) })),
  stillFailing: stillFailing.map((f) => ({ test: f.name, file: relFromRepo(f.file) })),
  suiteLoadFailures: suiteLoadFailures.map((f) => relFromRepo(f)),
  hardFailure,
};

const markdown = [
  `### Flake report — ${suite.label}${shard ? ` (shard ${shard})` : ""}`,
  "",
  hardFailure
    ? `Hard failure: \`${hardFailure}\``
    : report.retried
      ? `Re-ran ${report.retriedFiles.length} file(s) after the first run failed.`
      : "Passed on the first run; no retry needed.",
  "",
  `Flakes recovered on retry: **${report.flakes.length}**`,
  "",
];
if (report.flakes.length) {
  markdown.push("| Test | File |", "| --- | --- |");
  for (const flake of report.flakes) markdown.push(`| ${flake.test} | \`${flake.file}\` |`);
  markdown.push("");
}
if (report.stillFailing.length) {
  markdown.push(`Still failing: **${report.stillFailing.length}**`, "", "| Test | File |", "| --- | --- |");
  for (const failure of report.stillFailing) markdown.push(`| ${failure.test} | \`${failure.file}\` |`);
  markdown.push("");
}
if (report.suiteLoadFailures.length) {
  markdown.push(`Test files that failed to load: ${report.suiteLoadFailures.map((f) => `\`${f}\``).join(", ")}`, "");
}

writeFileSync(resolve(outDir, "flake-report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(outDir, "flake-report.md"), `${markdown.join("\n")}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.join("\n")}\n`);
}

if (report.flakes.length) {
  const list = report.flakes.map((f) => `${f.test} (${f.file})`).join("; ");
  console.warn(`::warning title=Flaky tests recovered on retry::${list}. Fix or quarantine them (see test/quarantine.json).`);
}

const failed =
  Boolean(hardFailure) ||
  report.stillFailing.length > 0 ||
  report.suiteLoadFailures.length > 0 ||
  (report.retried && retryExit !== 0 && report.flakes.length === 0);
process.exit(failed ? 1 : 0);
