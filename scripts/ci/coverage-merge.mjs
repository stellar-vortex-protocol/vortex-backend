#!/usr/bin/env node
// Merges the per-shard Istanbul coverage reports and enforces the coverage
// threshold on the merged result (issue #486).
//
// Why not `nyc merge` or `istanbul merge`: both are extra dependencies, and this
// repository's CI cannot add a package without also regenerating
// package-lock.json. Merging a coverage map is a counter sum, so it is done here
// directly, with no dependencies at all.
//
// The threshold is read from jest.config.js so there is exactly one definition
// of "70%". Shard runs deliberately do NOT enforce it -- a shard legitimately
// executes a subset of the suite -- only this script does, on the union.

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { REPO_ROOT, readJson, relFromRepo } from "./lib.mjs";

const require = createRequire(import.meta.url);

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (match) args.set(match[1], match[2] ?? "true");
}

const shardsDir = resolve(REPO_ROOT, args.get("shards") ?? "coverage-shards");
const outDir = resolve(REPO_ROOT, args.get("out") ?? "coverage");
const title = args.get("title") ?? "Coverage (merged from all Jest shards)";
const expectShards = args.has("expect-shards") ? Number(args.get("expect-shards")) : null;

const METRICS = ["lines", "statements", "functions", "branches"];

const findShardReports = () => {
  if (!existsSync(shardsDir)) {
    throw new Error(
      `no shard coverage found: ${relFromRepo(shardsDir)} does not exist. ` +
        `Every test shard must write its Istanbul report under that directory.`,
    );
  }
  const reports = [];
  for (const entry of readdirSync(shardsDir, { withFileTypes: true })) {
    const candidate = resolve(shardsDir, entry.name, "coverage-final.json");
    if (existsSync(candidate)) reports.push(candidate);
  }
  if (reports.length === 0) throw new Error(`no coverage-final.json under ${relFromRepo(shardsDir)}`);
  return reports.sort();
};

/**
 * Sum the counters of two Istanbul file-coverage records.
 *
 * statementMap/fnMap/branchMap are the static structure: identical across shards
 * because they are derived from the same source. The counter arrays s/f/b are
 * per-run hit counts, and summing them yields the union -- a statement hit by
 * shard 1 and shard 2 ends up with count 2, which is > 0 either way.
 */
const addFileCoverage = (base, incoming, file) => {
  if (!base) return structuredClone(incoming);

  for (const [counter, map] of [
    ["s", "statementMap"],
    ["f", "fnMap"],
  ]) {
    const baseKeys = Object.keys(base[map]).sort();
    const incomingKeys = Object.keys(incoming[map]).sort();
    if (baseKeys.join(",") !== incomingKeys.join(",")) {
      throw new Error(
        `${file}: ${map} differs between shards (${baseKeys.length} vs ${incomingKeys.length} keys). ` +
          `Shards must run the same source; a stale build or Prisma cache is the usual cause.`,
      );
    }
    for (const key of incomingKeys) base[counter][key] = (base[counter][key] ?? 0) + (incoming[counter][key] ?? 0);
  }

  const baseBranchKeys = Object.keys(base.b).sort();
  const incomingBranchKeys = Object.keys(incoming.b).sort();
  if (baseBranchKeys.join(",") !== incomingBranchKeys.join(",")) {
    throw new Error(`${file}: branchMap differs between shards. Shards must run the same source.`);
  }
  for (const key of incomingBranchKeys) {
    base.b[key] = base.b[key].map((count, i) => count + (incoming.b[key][i] ?? 0));
  }
  return base;
};

/** Per-file totals, computed the way istanbul's getCoverageSummary does. */
const summarizeFile = (record) => {
  const statementCounts = Object.values(record.s);
  const functionCounts = Object.values(record.f);
  const branchCounts = Object.values(record.b).flat();

  // Lines are derived from statements: a line is covered when any statement
  // starting on it was executed.
  const lines = new Map();
  for (const [key, loc] of Object.entries(record.statementMap)) {
    const line = loc.start.line;
    lines.set(line, Math.max(lines.get(line) ?? 0, record.s[key] ?? 0));
  }

  return {
    lines: { total: lines.size, covered: [...lines.values()].filter((c) => c > 0).length, skipped: 0 },
    statements: { total: statementCounts.length, covered: statementCounts.filter((c) => c > 0).length, skipped: 0 },
    functions: { total: functionCounts.length, covered: functionCounts.filter((c) => c > 0).length, skipped: 0 },
    branches: { total: branchCounts.length, covered: branchCounts.filter((c) => c > 0).length, skipped: 0 },
  };
};

const zeroTotals = () => ({ total: 0, covered: 0, skipped: 0 });
const addTotals = (a, b) => ({ total: a.total + b.total, covered: a.covered + b.covered, skipped: a.skipped + b.skipped });
const pct = (counts) => (counts.total === 0 ? 100 : (counts.covered / counts.total) * 100);

let reports;
try {
  reports = findShardReports();
  if (expectShards !== null && reports.length !== expectShards) {
    throw new Error(
      `expected ${expectShards} shard coverage report(s) under ${relFromRepo(shardsDir)}, found ${reports.length}. ` +
        `A shard probably failed before writing its report.`,
    );
  }
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

const merged = {};
const perShard = [];
for (const report of reports) {
  const data = readJson(report);
  for (const [file, record] of Object.entries(data)) {
    merged[file] = addFileCoverage(merged[file], record, relFromRepo(file));
  }
  perShard.push({ shard: relFromRepo(dirname(report)), files: Object.keys(data).length });
}

const totals = Object.fromEntries(METRICS.map((metric) => [metric, zeroTotals()]));
const summary = {};
for (const [file, record] of Object.entries(merged)) {
  const fileSummary = summarizeFile(record);
  for (const metric of METRICS) totals[metric] = addTotals(totals[metric], fileSummary[metric]);
  summary[file] = fileSummary;
}
summary.total = structuredClone(totals);

// The threshold lives in jest.config.js so it has a single definition.
const jestConfig = require(resolve(REPO_ROOT, "jest.config.js"));
const threshold = jestConfig.coverageThreshold?.global ?? {};

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "coverage-final.json"), `${JSON.stringify(merged, null, 2)}\n`);
writeFileSync(resolve(outDir, "coverage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const rows = METRICS.map((metric) => {
  const actual = pct(totals[metric]);
  const min = threshold[metric];
  return {
    metric,
    actual,
    min: min ?? null,
    pass: min === undefined || actual >= min,
    text: `${totals[metric].covered}/${totals[metric].total}`,
  };
});

// Best-effort lcov/html/text for humans. Never fatal: it depends on a transitive
// istanbul package being resolvable, and the coverage gate must not hinge on it.
let reportNote;
try {
  const libReport = require("istanbul-lib-report");
  const libCoverage = require("istanbul-lib-coverage");
  const context = libReport.createContext({
    dir: outDir,
    coverageMap: libCoverage.createCoverageMap(merged),
    defaultSummarizer: "pkg",
  });
  for (const format of ["lcovonly", "html", "text-summary"]) {
    context.report({ skipEmpty: true, skipFull: false }, [libReport.createReporter(format)]);
  }
  reportNote = "Wrote lcov, html and text-summary reports.";
} catch (error) {
  reportNote = `Merged JSON written; html/lcov not generated (${error.code ?? error.message}).`;
}

const failed = rows.filter((row) => !row.pass);
const markdown = [
  `### ${title}`,
  ``,
  `Merged ${reports.length} shard report(s) covering ${Object.keys(merged).length} files.`,
  ``,
  `| Metric | Merged | Threshold | Result |`,
  `| --- | --- | --- | --- |`,
  ...rows.map(
    (r) =>
      `| ${r.metric} | ${r.text} (${r.actual.toFixed(2)}%) | ${r.min === null ? "-" : `${r.min}%`} | ${r.pass ? "pass" : "**fail**"} |`,
  ),
  ``,
  reportNote,
  ``,
  `Shards: ${perShard.map((s) => `\`${s.shard}\` (${s.files} files)`).join(", ")}`,
  ``,
];

writeFileSync(resolve(outDir, "merged-coverage.md"), `${markdown.join("\n")}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.join("\n")}\n`);
}

for (const row of rows) {
  const thresholdText = row.min === null ? "" : ` (threshold ${row.min}%)`;
  console.log(`${row.pass ? "pass" : "FAIL"}  ${row.metric.padEnd(10)} ${row.text.padEnd(12)} ${row.actual.toFixed(2)}%${thresholdText}`);
}
console.log(reportNote);

if (failed.length) {
  console.error(
    `::error::Merged coverage is below the configured threshold for: ${failed.map((r) => r.metric).join(", ")}. ` +
      `The threshold is enforced on the merged report, never per shard.`,
  );
  process.exit(1);
}
