#!/usr/bin/env node
/**
 * compare-results.mjs
 *
 * Compares a k6 JSON summary output against the stored baseline budgets and
 * exits non-zero if any metric exceeds its baseline by more than the configured
 * tolerance (default: +15%).
 *
 * Usage:
 *   node test/perf/k6/scripts/compare-results.mjs \
 *     --results  test/perf/k6/results/all-scenarios-latest.json \
 *     --baseline test/perf/k6/baselines/all-scenarios.json \
 *     [--tolerance 15]          # override tolerance %
 *     [--output   report.md]    # write markdown report to file (for PR comment)
 *
 * Exit codes:
 *   0 — all metrics within tolerance
 *   1 — one or more metrics exceed budget
 *   2 — bad arguments / file not found
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const resultsPath  = getArg('--results');
const baselinePath = getArg('--baseline');
const outputPath   = getArg('--output');
const tolerancePct = parseFloat(getArg('--tolerance') ?? '15');

if (!resultsPath || !baselinePath) {
  console.error('Usage: compare-results.mjs --results <file> --baseline <file> [--tolerance 15] [--output report.md]');
  process.exit(2);
}

for (const p of [resultsPath, baselinePath]) {
  if (!existsSync(resolve(p))) {
    console.error(`File not found: ${p}`);
    process.exit(2);
  }
}

// ── Load files ────────────────────────────────────────────────────────────────
let results, baseline;
try {
  results  = JSON.parse(readFileSync(resolve(resultsPath), 'utf8'));
  baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8'));
} catch (err) {
  console.error(`Failed to parse JSON: ${err.message}`);
  process.exit(2);
}

const tolerance = tolerancePct / 100;
const baselineMetrics = baseline.metrics ?? {};

// ── Extract metric value from k6 summary ──────────────────────────────────────
/**
 * Navigate the k6 summary JSON to find a named metric value.
 *
 * k6 summary structure (end-of-test JSON):
 *   data.metrics.<metricName>.values.{ "p(95)": N, "p(99)": N, "rate": N, "count": N, ... }
 *
 * @param {object} data - parsed k6 summary JSON
 * @param {string} metricName
 * @param {string} valueName - e.g. "p(95)", "rate", "count"
 * @returns {number | null}
 */
function extractMetric(data, metricName, valueName) {
  const metric = data?.metrics?.[metricName];
  if (!metric) return null;
  const val = metric.values?.[valueName] ?? metric.values?.[valueName.replace('(', '(').replace(')', ')')];
  return typeof val === 'number' ? val : null;
}

// ── Comparison logic ──────────────────────────────────────────────────────────
const rows   = [];  // { metric, stat, baseline, actual, budgetLimit, status }
const errors = [];  // failing rows

/**
 * Compare a single (metric, stat, baselineMs, actualMs) tuple.
 *
 * @param {string} metric
 * @param {string} stat       - human label e.g. "p95"
 * @param {string} k6ValueKey - k6 value key e.g. "p(95)"
 * @param {number} baselineVal
 * @param {number|null} actualVal
 * @param {'lower_is_better'|'higher_is_better'} direction
 */
function compare(metric, stat, k6ValueKey, baselineVal, actualVal, direction = 'lower_is_better') {
  if (actualVal === null) {
    rows.push({ metric, stat, baseline: baselineVal, actual: 'n/a', budgetLimit: '—', status: '⚠️ missing' });
    return;
  }

  let budgetLimit, exceeded;
  if (direction === 'lower_is_better') {
    budgetLimit = baselineVal * (1 + tolerance);
    exceeded = actualVal > budgetLimit;
  } else {
    budgetLimit = baselineVal * (1 - tolerance);
    exceeded = actualVal < budgetLimit;
  }

  const status = exceeded ? '❌ FAIL' : '✅ pass';
  rows.push({
    metric,
    stat,
    baseline: fmt(baselineVal, stat),
    actual:   fmt(actualVal, stat),
    budgetLimit: fmt(budgetLimit, stat),
    status,
  });

  if (exceeded) errors.push({ metric, stat, baseline: baselineVal, actual: actualVal, budgetLimit });
}

function fmt(val, stat) {
  if (stat === 'rate_max' || stat === 'rate') return `${(val * 100).toFixed(3)}%`;
  if (stat === 'count_min' || stat === 'count') return String(Math.round(val));
  return `${val.toFixed(1)} ms`;
}

// ── Run comparisons ───────────────────────────────────────────────────────────
for (const [metricName, budget] of Object.entries(baselineMetrics)) {
  if (budget.p95_ms !== undefined) {
    const actual = extractMetric(results, metricName, 'p(95)');
    compare(metricName, 'p95', 'p(95)', budget.p95_ms, actual);
  }
  if (budget.p99_ms !== undefined) {
    const actual = extractMetric(results, metricName, 'p(99)');
    compare(metricName, 'p99', 'p(99)', budget.p99_ms, actual);
  }
  if (budget.rate_max !== undefined) {
    const actual = extractMetric(results, metricName, 'rate');
    compare(metricName, 'rate_max', 'rate', budget.rate_max, actual);
  }
  if (budget.count_min !== undefined) {
    const actual = extractMetric(results, metricName, 'count');
    compare(metricName, 'count_min', 'count', budget.count_min, actual, 'higher_is_better');
  }
}

// ── Render markdown report ────────────────────────────────────────────────────
const timestamp  = results.timestamp ?? new Date().toISOString();
const baseUrl    = results.baseUrl ?? '(unknown)';
const runnerInfo = `${timestamp} — ${baseUrl}`;

let md = `## ⚡ k6 Performance Report

> Run: ${runnerInfo}
> Tolerance: ±${tolerancePct}%

`;

if (errors.length === 0) {
  md += `### ✅ All metrics within budget\n\n`;
} else {
  md += `### ❌ ${errors.length} metric(s) exceeded budget\n\n`;
  md += `<details><summary>Failing metrics</summary>\n\n`;
  for (const e of errors) {
    const actual    = fmt(e.actual, e.stat);
    const limit     = fmt(e.budgetLimit, e.stat);
    const base      = fmt(e.baseline, e.stat);
    md += `- **${e.metric}** \`${e.stat}\`: actual=${actual}, limit=${limit} (baseline=${base} + ${tolerancePct}%)\n`;
  }
  md += `\n</details>\n\n`;
}

md += `### Metric Comparison Table\n\n`;
md += `| Metric | Stat | Baseline | Actual | Budget (baseline+${tolerancePct}%) | Status |\n`;
md += `|--------|------|----------|--------|-------------------------------|--------|\n`;
for (const r of rows) {
  md += `| \`${r.metric}\` | ${r.stat} | ${r.baseline} | ${r.actual} | ${r.budgetLimit} | ${r.status} |\n`;
}

md += `\n<details><summary>Raw k6 threshold results</summary>\n\n\`\`\`\n`;
for (const [name, metric] of Object.entries(results?.metrics ?? {})) {
  if (metric?.thresholds) {
    for (const [expr, passed] of Object.entries(metric.thresholds)) {
      md += `${name}: ${expr} → ${passed.ok ? 'pass' : 'FAIL'}\n`;
    }
  }
}
md += `\`\`\`\n\n</details>\n`;

// ── Output ────────────────────────────────────────────────────────────────────
console.log(md);

if (outputPath) {
  writeFileSync(resolve(outputPath), md, 'utf8');
  console.error(`Report written to ${outputPath}`);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} metric(s) exceeded the baseline budget (tolerance: +${tolerancePct}%).`);
  console.error('Update baselines with: npm run perf:update-baselines');
  process.exit(1);
}

console.error(`\nAll metrics within budget (+${tolerancePct}% tolerance). ✅`);
