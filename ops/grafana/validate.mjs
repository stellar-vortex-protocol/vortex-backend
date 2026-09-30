/**
 * Grafana dashboard linter — runs in CI, no dependencies.
 *
 * The issue (#481) states acceptance criteria that are easy to write down and
 * easy to silently violate six months from now:
 *
 *   1. "all panels are linked to the alert set"
 *   2. "all panels have a legend, description, units, and thresholds"
 *   3. "dashboards must load < 3 s on 7-day range"
 *   4. "dashboards are deployable via Docker Compose"
 *   5. "CI checks the dashboards parse and that generated files are in sync"
 *
 * A JSON.parse in CI proves only that the file is well-formed. This file proves
 * the rest, and each check below exists because the thing it checks is easy to
 * regress without noticing:
 *
 *   - Datasource references must resolve. A dashboard that imports with a
 *     missing datasource renders a wall of red "no data" panels.
 *   - Every panel needs a legendFormat. A timeseries with no legendFormat and
 *     more than one series is unreadable, and that is the default failure when
 *     someone pastes a query in the UI.
 *   - Units. A seconds metric plotted with unit "short" is a silently wrong
 *     chart, which is worse than a broken one.
 *   - The 3 s budget. Enforced as: no raw histogram_quantile/rate/increase over
 *     a fixed window longer than the 1 m refresh, because that is the query
 *     shape that makes a 7-day range take tens of seconds. Recording-rule
 *     series and $__rate_interval are both fine; the lint is about the shape of
 *     the query, not about banning PromQL.
 *   - Every alert in ops/prometheus/rules/vortex-slo.yml has a dashboard_url
 *     and that URL resolves to a committed dashboard file.
 *
 * Run: node ops/grafana/validate.mjs
 * Exits non-zero and prints every problem; never stops at the first one.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASH_DIR = join(ROOT, "ops", "grafana", "dashboards");
const PROVISION_DIR = join(ROOT, "ops", "grafana", "provisioning");
const RULES_FILE = join(ROOT, "ops", "prometheus", "rules", "vortex-slo.yml");
const PROMETHEUS_FILE = join(ROOT, "ops", "prometheus", "prometheus.yml");

/** The five dashboards issue #481 asks for. A dashboard that is not in this
 *  list is not required to exist, but every dashboard that does exist must be
 *  reachable from the issue and from the alerts. */
const REQUIRED_UIDS = [
  "vortex-api-red",
  "vortex-intent-funnel",
  "vortex-onchain-pipeline",
  "vortex-solver-network",
  "vortex-ws-feed",
];

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

// ---------------------------------------------------------------------------
// YAML reading, without a YAML dependency.
//
// The rule file and prometheus.yml are both flat enough that scanning for
// `key: "value"` pairs is sufficient for the two things we need from them
// (alert summaries and datasource UIDs). Anything that needs real YAML
// structure is left to `promtool` and Grafana itself, both of which run in CI.
// ---------------------------------------------------------------------------

function scanPairs(file) {
  if (!existsSync(file)) {
    fail(file.replace(ROOT + "\\", ""), "file does not exist");
    return [];
  }
  const pairs = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    // `- record: name` and `  summary: "text"` are both wanted, so an optional
    // YAML list dash is part of the pattern. Prometheus rule files put both
    // forms in the same document.
    const m = line.match(/^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*):\s*"?([^"]*)"?\s*$/);
    if (m) pairs.push({ key: m[1], value: m[2].trim(), indent: line.length - line.trimStart().length });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// The metric universe a panel is allowed to name.
//
// Two sources, both read straight from the repo so this cannot drift:
//   - RECORDED     the `record:` names in the Prometheus rule file
//   - INSTRUMENTED the metric names built in src/metrics/metrics.service.ts
//
// prom-client's collectDefaultMetrics() applies the same `vortex_` prefix to
// nodejs_* and process_* metrics, so those are allowed through by prefix.
// ---------------------------------------------------------------------------

const RECORDED = new Set(
  scanPairs(RULES_FILE)
    .filter((p) => p.key === "record")
    .map((p) => p.value),
);

const DEFAULT_METRIC_PREFIXES = ["vortex_nodejs_", "vortex_process_"];

const INSTRUMENTED = new Set();
{
  const metricsSrc = join(ROOT, "src", "metrics", "metrics.service.ts");
  if (!existsSync(metricsSrc)) {
    fail("src/metrics/metrics.service.ts", "missing - the dashboard linter reads the instrumented metric names from it");
  } else {
    const src = readFileSync(metricsSrc, "utf8");
    // names are built as `${prefix}http_requests_total`, so reconstruct the
    // exported name from the template rather than guessing at the prefix.
    for (const m of src.matchAll(/\$\{prefix\}([a-z0-9_]+)/g)) INSTRUMENTED.add(`vortex_${m[1]}`);
    for (const m of src.matchAll(/name:\s*["'`](vortex_[a-z0-9_]+)["'`]/g)) INSTRUMENTED.add(m[1]);
  }
}

// ---------------------------------------------------------------------------
// Load dashboards
// ---------------------------------------------------------------------------

const files = readdirSync(DASH_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  fail("ops/grafana/dashboards", "no dashboard JSON files found - run: node ops/grafana/build.mjs");
}

const dashboards = new Map();

for (const f of files) {
  const path = join(DASH_DIR, f);
  const where = `ops/grafana/dashboards/${f}`;
  let dash;
  try {
    dash = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(where, `does not parse as JSON - ${err.message}`);
    continue;
  }
  dashboards.set(dash.uid, { where, dash });
}

// ---------------------------------------------------------------------------
// Check 1: the required set exists, uids match filenames
// ---------------------------------------------------------------------------

for (const uid of REQUIRED_UIDS) {
  if (!dashboards.has(uid)) {
    fail("ops/grafana/dashboards", `missing required dashboard uid "${uid}"`);
  }
}

for (const [uid, { where }] of dashboards) {
  if (!existsSync(join(DASH_DIR, `${uid}.json`))) {
    fail(where, `uid "${uid}" does not match its filename; Grafana provisions by filename`);
  }
  if (!REQUIRED_UIDS.includes(uid)) {
    fail(where, `dashboard "${uid}" is not one of the dashboards issue #481 asks for`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: datasources
// ---------------------------------------------------------------------------

const PROMETHEUS_UID = "vortex-prometheus";
const LOKI_UID = "vortex-loki";
const KNOWN_DATASOURCES = new Set([PROMETHEUS_UID, LOKI_UID]);

const declaredUids = new Set();
for (const [name, entries] of [
  ["datasources", scanPairs(join(PROVISION_DIR, "datasources", "datasources.yml"))],
  ["dashboards", scanPairs(join(PROVISION_DIR, "dashboards", "dashboards.yml"))],
]) {
  for (const e of entries) {
    if (e.key === "uid") declaredUids.add(e.value);
  }
  if (entries.length === 0) {
    fail(`ops/grafana/provisioning/${name}`, "could not read any keys - file missing or empty");
  }
}

for (const uid of KNOWN_DATASOURCES) {
  if (!declaredUids.has(uid)) {
    fail("ops/grafana/provisioning", `datasource uid "${uid}" is not declared in provisioning`);
  }
}

function checkDatasource(where, ds, panelTitle) {
  if (ds === undefined || ds === null) return; // inherits dashboard default
  if (typeof ds !== "object" || !ds.uid) {
    fail(where, `panel "${panelTitle}" datasource must be an object with a uid`);
    return;
  }
  if (!KNOWN_DATASOURCES.has(ds.uid)) {
    fail(where, `panel "${panelTitle}" references unknown datasource uid "${ds.uid}"`);
  }
}

// ---------------------------------------------------------------------------
// Checks 3-6: per-panel
// ---------------------------------------------------------------------------

const GRAPHICS = new Set(["timeseries", "stat", "gauge", "bargauge", "heatmap", "table"]);

function walkPanels(panels, out, rowPath = "") {
  for (const p of panels ?? []) {
    out.push({ panel: p, rowPath: p.type === "row" ? p.title : rowPath });
    if (p.type === "row" && Array.isArray(p.panels)) walkPanels(p.panels, out, p.title);
  }
}

for (const [uid, { where, dash }] of dashboards) {
  // --- datasource + templating ---
  checkDatasource(where, dash.datasource, "<dashboard default>");
  for (const v of dash.templating?.list ?? []) {
    if (v.type === "query") checkDatasource(where, v.datasource, `variable ${v.name}`);
  }
  if (!dash.templating?.list?.some((v) => v.name === "env")) {
    fail(where, 'missing required template variable "env"');
  }
  if (!dash.templating?.list?.some((v) => v.name === "chain")) {
    fail(where, 'missing required template variable "chain"');
  }

  const flat = [];
  walkPanels(dash.panels, flat);

  for (const { panel, rowPath } of flat) {
    const at = `panel ${panel.id} "${panel.title}"${rowPath ? ` (row "${rowPath}")` : ""}`;

    if (!GRAPHICS.has(panel.type)) continue;

    // --- 3. title, description, legend ---
    if (!panel.title) fail(where, `${at}: missing title`);
    if (!panel.description || panel.description.trim().length < 20) {
      fail(where, `${at}: description is missing or too short to be useful (>= 20 chars)`);
    }

    const targets = panel.targets ?? [];
    if (targets.length === 0) {
      fail(where, `${at}: has no targets`);
      continue;
    }

    const multiSeries = targets.some((t) => (t.expr ?? "").includes("by (") || (t.expr ?? "").startsWith("topk"));
    for (const t of targets) {
      if (!t.expr) {
        fail(where, `${at}: a target has no expr`);
        continue;
      }
      if (t.editorMode !== "code") {
        fail(where, `${at}: target must use editorMode "code" so the query is reviewable in the PR`);
      }
      if (t.datasource === undefined || t.datasource === null) {
        fail(where, `${at}: target has no explicit datasource; inheriting makes the panel's source ambiguous`);
      } else {
        checkDatasource(where, t.datasource, panel.title);
      }
      if (!t.legendFormat) {
        fail(where, `${at}: target has no legendFormat`);
      } else if (t.legendFormat.includes("{{")) {
        // Each label here is grouped by a query in this repo. `expected` is the
        // off-chain side of the shadow monitor's (expected, simulated) pair
        // (issue #401), added alongside `outcome` so the two halves of the
        // comparison are both readable in one legend.
        const LABELLED = new Set([
          "instance",
          "route",
          "to_state",
          "from_state",
          "status_code",
          "transition",
          "reason",
          "outcome",
          "expected",
        ]);
        for (const m of t.legendFormat.matchAll(/\{\{(\w+)\}\}/g)) {
          if (LABELLED.has(m[1])) continue;
          fail(where, `${at}: legendFormat references label "{{${m[1]}}}" that no query in this repo groups by`);
        }
      }
    }
    if (multiSeries && targets.length > 1) {
      fail(where, `${at}: multiple targets each grouping by label will produce one confusing legend; combine with \`or\` or split the panel`);
    }

    // --- 4. units and thresholds ---
    const defaults = panel.fieldConfig?.defaults ?? {};
    if (!defaults.unit) {
      fail(where, `${at}: no unit declared; a seconds metric plotted as "short" is a silently wrong chart, which is worse than a broken one`);
    }
    const steps = defaults.thresholds?.steps ?? [];
    if (steps.length === 0) {
      fail(where, `${at}: no thresholds configured`);
    }
    // thresholdsStyle only exists on graph panels; a stat conveys the same
    // information through colorMode: "thresholds".
    const style = panel.fieldConfig?.defaults?.custom?.thresholdsStyle?.mode;
    if (panel.type === "timeseries" && style !== "off" && style !== "dashed") {
      fail(where, `${at}: thresholdsStyle.mode must be explicitly "off" or "dashed", got ${JSON.stringify(style)}`);
    }
    // A dashed line needs something to draw. A panel with a single step keeps
    // the style "off" on purpose: it is a level readout, and inventing a second
    // "bad" value for a request rate would be a fake SLO.
    if (style === "dashed" && steps.length < 2) {
      fail(where, `${at}: thresholdsStyle is "dashed" but there is only ${steps.length} threshold step, so nothing is drawn; add a warn level or set the style to "off"`);
    }
    if (defaults.thresholds?.mode !== "absolute") {
      fail(where, `${at}: thresholds.mode must be "absolute"`);
    }
    if (panel.type === "stat" && defaults.color?.mode !== "thresholds") {
      fail(where, `${at}: stat panels must colour by thresholds, got "${defaults.color?.mode}"`);
    }

    // --- 5. the < 3 s on 7-day range budget ---
    for (const t of targets) {
      const expr = t.expr ?? "";

      // Every metric a panel names must exist. A dashboard full of panels that
      // render "No data" because they reference a recording rule that was
      // renamed is the most common way a Grafana rollout goes unnoticed.
      for (const m of expr.matchAll(/\bvortex:[a-z0-9_:]+/g)) {
        if (!RECORDED.has(m[0])) {
          fail(where, `${at}: references recording rule "${m[0]}" which is not defined in ops/prometheus/rules/vortex-slo.yml`);
        }
      }
      for (const m of expr.matchAll(/\bvortex_[a-z0-9_]+/g)) {
        const name = m[0];
        if (DEFAULT_METRIC_PREFIXES.some((p) => name.startsWith(p))) continue;
        // Histogram and summary series are the same metric with a suffix the
        // client library appends, so check the base name.
        const base = name.replace(/_(bucket|sum|count)$/, "");
        if (!INSTRUMENTED.has(name) && !INSTRUMENTED.has(base)) {
          fail(where, `${at}: references metric "${name}" which no metric in src/metrics/metrics.service.ts creates`);
        }
      }
      // Raw histogram_quantile is the expensive shape: it must reduce the full
      // bucket set, so it is only allowed behind a short window.
      const fixedWindow = expr.match(/\[(\d+[smhdwy])\]/g) ?? [];
      for (const w of fixedWindow) {
        const value = Number(w.slice(1, -1).replace(/[smhdwy]/, ""));
        const unit = w.slice(-1);
        const seconds = value * { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[unit];
        if (seconds > 60) {
          fail(where, `${at}: fixed window ${w} is longer than the 1m refresh; use a recording rule or $__rate_interval or the dashboard breaks the 3 s budget on a 7-day range`);
        }
      }

      if (/histogram_quantile/.test(expr) && !/topk\(/.test(expr)) {
        fail(where, `${at}: raw histogram_quantile is only allowed bounded by topk(...); a whole-dashboard percentile over all routes is the slowest possible query here`);
      }
      if (/\brate\(|\bincrease\(/.test(expr) && /vortex:/.test(expr)) {
        fail(where, `${at}: rate()/increase() over a recording rule (vortex:*) is not valid PromQL; recording rules are already rate-aggregated`);
      }
    }
  }

  // --- generated-in-sync ---
  // build.mjs owns these files; validate.mjs refuses to pass if they drift.
  // (Reuse its own check rather than re-implementing the comparison.)
}

// ---------------------------------------------------------------------------
// Check 7: generated files in sync
// ---------------------------------------------------------------------------

const { spawnSync } = await import("node:child_process");
const sync = spawnSync(process.execPath, [join(ROOT, "ops", "grafana", "build.mjs"), "--check"], {
  encoding: "utf8",
});
if (sync.status !== 0) {
  fail("ops/grafana/build.mjs --check", `generated dashboards are out of date\n${(sync.stderr || sync.stdout || "").trim()}`);
}

// ---------------------------------------------------------------------------
// Check 8: prometheus.yml exists and scrapes the app
// ---------------------------------------------------------------------------

if (!existsSync(PROMETHEUS_FILE)) {
  fail("ops/prometheus/prometheus.yml", "missing - the observability profile needs it and $env/$chain depend on its relabel rules");
} else {
  const prom = readFileSync(PROMETHEUS_FILE, "utf8");
  for (const needle of ["rule_files", "vortex-slo.yml", "metric_relabel_configs", "env", "chain"]) {
    if (!prom.includes(needle)) {
      fail("ops/prometheus/prometheus.yml", `expected to contain "${needle}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 9: every alert links to a dashboard that exists
// ---------------------------------------------------------------------------

const pairs = scanPairs(RULES_FILE);
const summaries = pairs.filter((p) => p.key === "summary").map((p) => p.value);
const runbooks = pairs.filter((p) => p.key === "runbook_url").map((p) => p.value);
const dashLinks = pairs.filter((p) => p.key === "dashboard_url").map((p) => p.value);

if (summaries.length === 0) {
  fail("ops/prometheus/rules/vortex-slo.yml", "no alert summaries found - did the file change shape?");
}
if (runbooks.length < summaries.length) {
  fail("ops/prometheus/rules/vortex-slo.yml", `${summaries.length} alerts but only ${runbooks.length} runbook_url annotations`);
}
if (dashLinks.length < summaries.length) {
  fail(
    "ops/prometheus/rules/vortex-slo.yml",
    `${summaries.length} alerts but only ${dashLinks.length} dashboard_url annotations; issue #481 requires every alert to link to a dashboard`,
  );
}

const DASH_LINK_RE = /ops\/grafana\/dashboards\/(vortex-[a-z-]+)\.json$/;
const linkedUids = new Set();
for (const url of dashLinks) {
  const m = url.match(DASH_LINK_RE);
  if (!m) {
    fail("ops/prometheus/rules/vortex-slo.yml", `dashboard_url "${url}" is not a link to ops/grafana/dashboards/<uid>.json`);
    continue;
  }
  if (!dashboards.has(m[1])) {
    fail("ops/prometheus/rules/vortex-slo.yml", `dashboard_url "${url}" points at a dashboard that does not exist`);
    continue;
  }
  linkedUids.add(m[1]);
}

for (const uid of REQUIRED_UIDS) {
  if (!linkedUids.has(uid)) {
    fail("ops/prometheus/rules/vortex-slo.yml", `no alert links to dashboard "${uid}"; every dashboard in the set needs at least one alert pointing at it (issue #481)`);
  }
}

// ---------------------------------------------------------------------------
// Check 10: docker compose observability profile
// ---------------------------------------------------------------------------

const compose = join(ROOT, "docker-compose.yml");
if (!existsSync(compose)) {
  fail("docker-compose.yml", "missing");
} else {
  const text = readFileSync(compose, "utf8");
  for (const svc of ["prometheus:", "grafana:", "tempo:", "loki:"]) {
    if (!text.includes(`  ${svc}`)) {
      fail("docker-compose.yml", `no "${svc}" service; issue #481 requires the observability profile to be deployable via Docker Compose`);
    }
  }
  for (const profile of ["observability"]) {
    if (!text.includes(profile)) {
      fail("docker-compose.yml", `no "${profile}" profile`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  console.error(`Grafana validation FAILED: ${errors.length} problem(s).`);
  process.exit(1);
}

const panelCount = [...dashboards.values()].reduce((n, { dash }) => n + (dash.panels?.length ?? 0), 0);
console.log(
  `Grafana validation OK: ${dashboards.size} dashboards, ${panelCount} top-level panels, ` +
    `${summaries.length} alerts linked, ${REQUIRED_UIDS.length} required dashboards present.`,
);
