#!/usr/bin/env node
// Validates test/quarantine.json (issue #486).
//
// A quarantine is a promise that someone will fix a known-flaky test, so the
// file is only useful if it cannot rot. This check fails when an entry is
// missing an owner or an issue link, points at a file that no longer exists, or
// is duplicated. Entries older than `staleAfterDays` also exit non-zero, because
// an unowned quarantine that outlives its expiry is the failure mode this file
// exists to prevent; pass --no-strict to downgrade that specific failure to a
// warning.

import { appendFileSync } from "node:fs";
import { loadQuarantine, QUARANTINE_PATH, relFromRepo } from "./lib.mjs";

const REPO_SLUG = "stellar-vortex-protocol/vortex-backend";

const args = new Set(process.argv.slice(2));
const strict = !args.has("--no-strict");

let quarantine;
try {
  quarantine = loadQuarantine();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

const { quarantined, staleAfterDays } = quarantine;

if (quarantined.length === 0) {
  console.log(`No quarantined tests (${relFromRepo(QUARANTINE_PATH)} is empty).`);
  process.exit(0);
}

for (const entry of quarantined) {
  console.log(`quarantined: ${entry.path}`);
  console.log(`  owner=${entry.owner}  issue=${entry.issue}  added=${entry.addedAt}  age=${entry.ageDays}d`);
  console.log(`  reason: ${entry.reason}`);
}

const issueUrl = (issue) =>
  issue.startsWith("#") ? `https://github.com/${REPO_SLUG}/issues/${issue.slice(1)}` : issue;

const stale = quarantined.filter((entry) => entry.stale);

const markdown = [
  "### Quarantined tests",
  "",
  `| Test | Owner | Issue | Added | Age |`,
  `| --- | --- | --- | --- | --- |`,
  ...quarantined.map(
    (e) => `| \`${e.path}\` | ${e.owner} | [${e.issue}](${issueUrl(e.issue)}) | ${e.addedAt} | ${e.ageDays}d |`,
  ),
  "",
];

if (stale.length === 0) {
  markdown.push(`All entries are within the ${staleAfterDays}-day expiry window.`, "");
  appendSummary(markdown);
  process.exit(0);
}

const message = `${stale.length} quarantined test(s) are older than ${staleAfterDays} days: ${stale
  .map((e) => `\`${e.path}\``)
  .join(", ")}. Fix the test, or re-quarantine it with a fresh issue and a new expiry.`;

markdown.push(`> :warning: ${message}`, "");

if (strict) {
  console.error(`::error::${message}`);
  appendSummary(markdown);
  process.exit(1);
}

console.warn(`::warning::${message}`);
appendSummary(markdown);
process.exit(0);

function appendSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}
