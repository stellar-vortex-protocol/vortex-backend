#!/usr/bin/env node
/**
 * update-baselines.mjs
 *
 * Reads the latest k6 JSON summary output and updates the reference values
 * in test/perf/k6/baselines/all-scenarios.json.
 *
 * The BUDGET thresholds (p95_ms, p99_ms, rate_max, count_min) are NOT changed
 * by this script — those are intentional limits set by the team.
 * Only the `reference` section (actual measured values on main) is updated.
 *
 * Usage (after a successful perf run on main):
 *   npm run perf:update-baselines
 *   # which calls:
 *   node test/perf/k6/scripts/update-baselines.mjs \
 *     --results test/perf/k6/results/all-scenarios-latest.json
 *
 * Exit:
 *   0 — baselines updated
 *   1 — results file missing / malformed
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const resultsPath  = getArg('--results') ?? resolve(__dirname, '../results/all-scenarios-latest.json');
const baselinePath = resolve(__dirname, '../baselines/all-scenarios.json');

if (!existsSync(resultsPath)) {
  console.error(`Results file not found: ${resultsPath}`);
  console.error('Run the perf suite first: npm run perf');
  process.exit(1);
}

let results, baseline;
try {
  results  = JSON.parse(readFileSync(resultsPath, 'utf8'));
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (err) {
  console.error(`JSON parse error: ${err.message}`);
  process.exit(1);
}

/**
 * Extract a metric value from the k6 summary JSON.
 */
function extract(metricName, valueName) {
  const val = results?.metrics?.[metricName]?.values?.[valueName];
  return typeof val === 'number' ? Math.round(val * 100) / 100 : null;
}

const now = new Date().toISOString();

// Build updated reference block
const reference = {
  capturedAt: now,
  environment: 'ubuntu-latest / postgres:16-alpine / memory persistence',
};

const metricKeys = [
  ['http_req_duration', 'p(95)', 'http_req_duration_p95_ms'],
  ['http_req_duration', 'p(99)', 'http_req_duration_p99_ms'],
  ['perf_intent_create_duration', 'p(95)', 'perf_intent_create_duration_p95_ms'],
  ['perf_solver_poll_duration', 'p(95)', 'perf_solver_poll_duration_p95_ms'],
  ['perf_quote_duration', 'p(95)', 'perf_quote_duration_p95_ms'],
  ['perf_lifecycle_duration', 'p(95)', 'perf_lifecycle_duration_p95_ms'],
  ['perf_reads_duration', 'p(95)', 'perf_reads_duration_p95_ms'],
];

for (const [metric, valueKey, refKey] of metricKeys) {
  const val = extract(metric, valueKey);
  if (val !== null) reference[refKey] = val;
}

const failedRate = extract('http_req_failed', 'rate');
if (failedRate !== null) reference['http_req_failed_rate'] = failedRate;

// Update baseline file (keep budget thresholds, update reference)
baseline.reference = reference;
baseline._meta.generatedAt = now;

writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
console.log(`Baselines updated → ${baselinePath}`);
console.log('Reference values:');
for (const [k, v] of Object.entries(reference)) {
  if (k !== 'capturedAt' && k !== 'environment') {
    console.log(`  ${k}: ${v}`);
  }
}
