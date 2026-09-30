/**
 * Grafana dashboard generator — source of truth for ops/grafana/dashboards/*.json.
 *
 * ## Why a generator instead of grafonnet/Jsonnet
 *
 * The issue (#481) offered Jsonnet/grafonnet, the Grafana Foundation SDK, or
 * committed JSON as options. A code generator is only worth having if CI can
 * *run* it and prove the committed output matches. grafonnet requires a
 * `grafonnet` binary and Jsonnet requires `jsonnet`; neither is in the toolchain
 * and neither can be added without a package install, which this change is not
 * permitted to assume. A generator CI can actually run beats a generator CI
 * cannot verify.
 *
 * So: this file is the source of truth, `dashboards/*.json` is generated and
 * committed, and `validate.mjs` fails the build if the two ever disagree
 * (`node ops/grafana/build.mjs --check`). Nothing here depends on anything
 * outside Node's standard library.
 *
 * ## Why every panel targets a recording rule
 *
 * The issue's constraint is "dashboards must load < 3 s on 7-day range". A
 * panel running `histogram_quantile(0.99, sum(rate(..._bucket[5m])) by (le))`
 * over seven days is ~120k samples per series and takes tens of seconds. The
 * matching `vortex:*` recording rule in ops/prometheus/rules/vortex-slo.yml
 * turns the same question into a single-series read. Raw short-window queries
 * are allowed for the few breakdowns that have no natural pre-aggregation (a
 * per-route `topk`, for example); `validate.mjs` is what keeps that honest.
 *
 * ## Panel metadata is mandatory, not defaulted
 *
 * `timeseries()` and `stat()` throw if a panel is missing a description, a
 * legend, a unit or a threshold set. The issue asks for all four on every
 * panel, and a helper that quietly defaults them is how a panel ends up in the
 * repo with `unit: "short"` on a seconds metric — a chart that is silently
 * wrong, which is worse than a chart that is broken.
 *
 * Thresholds that are a real failure boundary use `thresholdsStyle: dashed` so
 * the line is visible on the graph. Panels that are pure level readouts (a
 * request rate, a queue depth) carry a single green step and stay `off`: there
 * is no honest "bad" value for them, and inventing one would be a fake SLO.
 *
 * Run: node ops/grafana/build.mjs [--check]
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "dashboards");

/** Datasource UIDs. Fixed, not a `$datasource` variable, so CI can prove every
 *  panel's datasource reference resolves to a provisioned datasource. */
const PROM = { type: "prometheus", uid: "vortex-prometheus" };
const LOKI = { type: "loki", uid: "vortex-loki" };

/** Selectors applied to raw (non-recording-rule) queries. */
const SEL = 'job=~"$job", instance=~"$instance", env=~"$env", chain=~"$chain"';
/** Same, minus `instance`, for metrics the app reports without a target label. */
const SEL_TOT = 'job=~"$job", env=~"$env", chain=~"$chain"';

const st = (color, value) => ({ color, value });
const steps = (...s) => ({ mode: "absolute", steps: s });

/** No failure boundary: a level readout. Single step, no threshold line. */
const LEVEL = steps(st("green", null));

/** Lower is better: an error/burn ratio. Warn at 0.1%, bad at 1%. */
const RATIO_LOW_OK = steps(st("green", null), st("orange", 0.001), st("red", 0.01));

/** Higher is better: a conversion ratio. Warn under 90%, bad under 99%. */
const RATIO_HIGH_OK = steps(st("green", null), st("orange", 0.9), st("red", 0.99));

/** Any "bad above X" bound, e.g. TH(0.5, 1) for a 500 ms latency budget. */
const TH = (warn, bad) => steps(st("green", null), st("orange", warn), st("red", bad));

/** Counts where any occurrence is worth seeing: green, then red at the first. */
const ANY_BAD = steps(st("green", null), st("red", 1));

/** The five dashboards the issue requires. */
const DASHBOARDS = [];

// ---------------------------------------------------------------------------
// Panel constructors. description / legendFormat / unit / thresholds are required.
// ---------------------------------------------------------------------------

let nextId = 1;
const panelIds = () => {
  nextId = 1;
  return () => nextId++;
};

function requireMeta(kind, title, meta) {
  const missing = ["description", "unit", "thresholds"].filter((k) => meta[k] === undefined || meta[k] === null);
  if (missing.length > 0) {
    throw new Error(`${kind} "${title}" is missing required panel metadata: ${missing.join(", ")}`);
  }
  if (typeof meta.description !== "string" || meta.description.trim().length < 20) {
    throw new Error(`${kind} "${title}" needs a description of at least 20 characters`);
  }
  // A legend is required per target, because that is where Grafana reads it
  // from. A multi-target panel is only allowed when the targets do not each
  // produce their own label set, otherwise they collide in one legend.
  const targets = meta.targets ?? [{ legendFormat: meta.legendFormat }];
  for (const t of targets) {
    if (!t.legendFormat) {
      throw new Error(`${kind} "${title}" has a target with no legendFormat`);
    }
  }
  if (targets.length > 1 && targets.some((t) => /\bby \(/.test(t.expr ?? "") || /^topk\(/.test(t.expr ?? ""))) {
    throw new Error(`${kind} "${title}" has multiple targets that each group by label; they will share one legend`);
  }
}

function defaults({ unit, thresholds, dashed, decimals, min, max }) {
  return {
    color: { mode: "thresholds" },
    custom: {
      axisBorderShow: false,
      axisCenteredZero: false,
      axisColorMode: "text",
      axisLabel: "",
      axisPlacement: "auto",
      barAlignment: 0,
      drawStyle: "line",
      fillOpacity: 8,
      gradientMode: "none",
      hideFrom: { legend: false, tooltip: false, viz: false },
      insertNulls: false,
      lineInterpolation: "linear",
      lineWidth: 1,
      pointSize: 5,
      scaleDistribution: { type: "linear" },
      showPoints: "never",
      spanNulls: false,
      stacking: { group: "A", mode: "none" },
      // A dashed threshold line is only drawn when there is a second step to
      // draw; LEVEL panels keep this "off" so the graph is not cluttered.
      thresholdsStyle: { mode: dashed ? "dashed" : "off" },
    },
    mappings: [],
    thresholds,
    unit,
    ...(decimals === undefined ? {} : { decimals }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

/**
 * @param {{title:string, description:string, gridPos:object, unit:string,
 *          thresholds:object, dashed?:boolean, decimals?:number,
 *          min?:number, max?:number, targets:Array, stack?:boolean,
 *          stackMode?:string, textMode?:string, noValue?:string, ds?:object}} o
 */
function timeseries(o) {
  requireMeta("timeseries", o.title, o);
  const d = defaults({ ...o, dashed: o.dashed === true });
  return {
    datasource: o.ds ?? PROM,
    description: o.description,
    fieldConfig: { defaults: d, overrides: [] },
    gridPos: o.gridPos,
    id: 0,
    options: {
      legend: { calcs: ["mean", "max", "lastNotNull"], displayMode: "list", placement: "bottom", showLegend: true },
      tooltip: { mode: "multi", sort: "desc" },
    },
    targets: o.targets.map((t, i) => ({
      datasource: t.ds ?? o.ds ?? PROM,
      editorMode: "code",
      expr: t.expr,
      legendFormat: t.legendFormat,
      range: true,
      refId: String.fromCharCode(65 + i),
    })),
    title: o.title,
    type: "timeseries",
  };
}

function stat(o) {
  requireMeta("stat", o.title, o);
  const d = defaults({ ...o, dashed: o.dashed === true });
  return {
    datasource: o.ds ?? PROM,
    description: o.description,
    fieldConfig: {
      defaults: {
        color: { mode: "thresholds" },
        mappings: o.noValue ? [{ options: { match: "null", result: { text: o.noValue } }, type: "special" }] : [],
        thresholds: o.thresholds,
        unit: o.unit,
        ...(o.decimals === undefined ? {} : { decimals: o.decimals }),
      },
      overrides: [],
    },
    gridPos: o.gridPos,
    id: 0,
    options: {
      colorMode: o.colorMode ?? "value",
      graphMode: "area",
      justifyMode: "auto",
      orientation: "auto",
      reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
      textMode: o.textMode ?? "auto",
      wideLayout: true,
    },
    targets: [
      {
        datasource: o.ds ?? PROM,
        editorMode: "code",
        expr: o.expr,
        legendFormat: o.legendFormat,
        range: true,
        refId: "A",
      },
    ],
    title: o.title,
    type: "stat",
  };
}

function text({ id = 0, title, description, gridPos, content }) {
  return {
    description: description ?? "",
    gridPos,
    id,
    options: { code: { language: "plaintext", showLineNumbers: false, showMiniMap: false }, content, mode: "markdown" },
    title,
    type: "text",
  };
}

const row = ({ id = 0, title, y }) => ({ collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, id, panels: [], title, type: "row" });

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

function queryVar(name, label, query, description) {
  return {
    current: {},
    datasource: PROM,
    definition: query,
    description,
    hide: 0,
    includeAll: true,
    allValue: ".*",
    label,
    multi: true,
    name,
    options: [],
    query: { query, refId: "PrometheusVariableQueryEditor-VariableQuery" },
    refresh: 1,
    regex: "",
    sort: 1,
    type: "query",
  };
}

function customVar(name, label, value, description) {
  return {
    current: { selected: true, text: value, value },
    description,
    hide: 0,
    label,
    name,
    options: [{ selected: true, text: value, value }],
    query: value,
    skipUrlSync: false,
    type: "custom",
  };
}

function templating() {
  return {
    list: [
      customVar(
        "env",
        "Environment",
        "local",
        "Set by ops/prometheus/prometheus.yml metric_relabel_configs. Change the literal there per environment.",
      ),
      customVar(
        "chain",
        "Chain",
        "testnet",
        "Stellar network the target runs against. Set by ops/prometheus/prometheus.yml metric_relabel_configs.",
      ),
      queryVar("job", "Job", "label_values(vortex_http_requests_total, job)", "Prometheus scrape job."),
      queryVar(
        "instance",
        "Instance",
        'label_values(vortex_http_requests_total{job=~"$job"}, instance)',
        "Scrape target. The up-gauge and the per-instance panels depend on this.",
      ),
    ],
  };
}

function crossLinks() {
  return [
    {
      asDropdown: true,
      icon: "dashboard",
      includeVars: true,
      keepTime: true,
      tags: ["vortex"],
      targetBlank: false,
      title: "Vortex dashboards",
      tooltip: "",
      type: "dashboards",
      url: "",
    },
    {
      asDropdown: false,
      icon: "doc",
      includeVars: false,
      keepTime: true,
      targetBlank: true,
      title: "Runbook: on-call",
      tooltip: "What to do when something here goes red",
      type: "link",
      url: "https://github.com/stellar-vortex-protocol/vortex-backend/blob/main/docs/runbooks/on-call.md",
    },
  ];
}

const DASH = (title, uid, tags, description) => ({
  __inputs: [],
  __requires: [],
  annotations: {
    list: [
      {
        builtIn: 1,
        datasource: { type: "grafana", uid: "-- Grafana --" },
        enable: true,
        hide: true,
        iconColor: "rgba(0, 211, 255, 1)",
        name: "Annotations & Alerts",
        type: "dashboard",
      },
    ],
  },
  description,
  editable: true,
  fiscalYearStartMonth: 0,
  graphTooltip: 1,
  id: null,
  links: crossLinks(),
  liveNow: false,
  panels: [],
  refresh: "1m",
  schemaVersion: 39,
  tags,
  templating: templating(),
  time: { from: "now-6h", to: "now" },
  timepicker: { refresh_intervals: ["10s", "30s", "1m", "5m", "15m", "1h"] },
  timezone: "browser",
  title,
  uid,
  version: 1,
  weekStart: "",
});

/** Appends a dashboard, giving every panel a unique id within it. */
function add(dash, panels) {
  const id = panelIds();
  for (const p of panels) p.id = id();
  dash.panels = panels;
  DASHBOARDS.push(dash);
}

// ---------------------------------------------------------------------------
// 1. API RED — Rate, Errors, Duration
// ---------------------------------------------------------------------------

add(
  DASH(
    "Vortex - API RED",
    "vortex-api-red",
    ["vortex", "slo", "api"],
    "Rate / Errors / Duration for the HTTP surface. Sourced from the vortex:http:* and vortex:create:* recording rules so a 7-day range renders from pre-aggregated series. Companion to the VortexHighBurnRate and VortexIntentCreateP95Slow alerts.",
  ),
  [
    row({ title: "Rate", y: 0 }),
    stat({
      title: "Request rate",
      description: "Total HTTP requests per second across the selected targets. Recording rule vortex:http:requests_per_second_5m, 5m window. Level readout: there is no failure rate, only traffic.",
      gridPos: { h: 4, w: 4, x: 0, y: 1 },
      expr: "vortex:http:requests_per_second_5m",
      legendFormat: "req/s",
      unit: "reqps",
      decimals: 2,
      thresholds: LEVEL,
    }),
    stat({
      title: "5xx rate",
      description: "HTTP 5xx responses per second (vortex:http:errors_per_second_5m). Read together with the ratio beside it: a low rate on a low request rate is still a broken relay.",
      gridPos: { h: 4, w: 4, x: 4, y: 1 },
      expr: "vortex:http:errors_per_second_5m",
      legendFormat: "5xx/s",
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    stat({
      title: "5xx ratio",
      description: "5xx as a fraction of all requests. This is the number the burn-rate alerts page on, and the one the availability SLO is written against.",
      gridPos: { h: 4, w: 4, x: 8, y: 1 },
      expr: "vortex:availability:error_ratio_5m",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 4,
      thresholds: RATIO_LOW_OK,
      dashed: true,
    }),
    stat({
      title: "Latency p95",
      description: "p95 request duration (vortex:http:p95_5m) against the 500ms warn / 1s bad budget used by the intent-create alert.",
      gridPos: { h: 4, w: 4, x: 12, y: 1 },
      expr: "vortex:http:p95_5m",
      legendFormat: "p95",
      unit: "s",
      decimals: 3,
      thresholds: TH(0.5, 1),
      dashed: true,
    }),
    stat({
      title: "Event ingestion lag",
      description: "Seconds between a Soroban event landing and Vortex ingesting it. Rising here is the earliest on-chain symptom, and it moves before any 5xx does.",
      gridPos: { h: 4, w: 4, x: 16, y: 1 },
      expr: `max(vortex_event_ingestion_lag_seconds{${SEL_TOT}})`,
      legendFormat: "lag",
      unit: "s",
      decimals: 1,
      thresholds: TH(10, 30),
      dashed: true,
    }),
    stat({
      title: "Targets up",
      description: "Prometheus up{job,instance}. 0 here means the scrape is failing, which makes every other panel on this dashboard read as zero rather than as a real outage - check this first.",
      gridPos: { h: 4, w: 4, x: 20, y: 1 },
      expr: `sum(up{${SEL}})`,
      legendFormat: "targets",
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),

    row({ title: "Errors", y: 5 }),
    timeseries({
      title: "5xx ratio vs burn-rate thresholds",
      description: "vortex:availability:error_ratio_5m with the 0.1%/1% warn and bad lines drawn on the graph. Cross the orange line and the burn-rate alert is a candidate.",
      gridPos: { h: 8, w: 12, x: 0, y: 6 },
      targets: [{ expr: "vortex:availability:error_ratio_5m", legendFormat: "error ratio" }],
      unit: "percentunit",
      decimals: 5,
      thresholds: RATIO_LOW_OK,
      dashed: true,
      min: 0,
    }),
    timeseries({
      title: "5xx/s by route",
      description: "Top 10 routes by 5xx rate. A short-window raw query on purpose: per-route cardinality is the entire point of the breakdown, and there is no recording rule that would keep it cheap.",
      gridPos: { h: 8, w: 12, x: 12, y: 6 },
      targets: [
        {
          expr: `topk(10, sum by (route) (rate(vortex_http_request_errors_total{${SEL}}[$__rate_interval])))`,
          legendFormat: "{{route}}",
        },
      ],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Requests/s by status class",
      description: "Request rate split by status_code. A stack that grows downward into 4xx is a client problem; growth in 5xx is ours.",
      gridPos: { h: 8, w: 12, x: 0, y: 14 },
      targets: [
        {
          expr: `sum by (status_code) (rate(vortex_http_requests_total{${SEL}}[$__rate_interval]))`,
          legendFormat: "HTTP {{status_code}}",
        },
      ],
      unit: "reqps",
      decimals: 2,
      thresholds: LEVEL,
      stack: true,
    }),

    row({ title: "Duration", y: 22 }),
    timeseries({
      title: "Latency percentiles",
      description: "p50 and p99 from the vortex:http:* recording rules. Both come from pre-aggregated series, which is what keeps a 7-day range inside the 3s budget.",
      gridPos: { h: 8, w: 12, x: 0, y: 23 },
      targets: [
        { expr: "vortex:http:p50_5m", legendFormat: "p50" },
        { expr: "vortex:http:p99_5m", legendFormat: "p99" },
      ],
      unit: "s",
      decimals: 3,
      thresholds: TH(0.5, 1),
      dashed: true,
    }),
    timeseries({
      title: "Intent-create p95 (VortexIntentCreateP95Slow)",
      description: "Latency of the intent-create handler, the metric behind the VortexIntentCreateP95Slow alert. Separate from overall p95 because create is the only write path.",
      gridPos: { h: 8, w: 12, x: 12, y: 23 },
      targets: [{ expr: "vortex:create:p95_5m", legendFormat: "intent create p95" }],
      unit: "s",
      decimals: 3,
      thresholds: TH(0.5, 1),
      dashed: true,
    }),
    timeseries({
      title: "p95 latency by route (top 10)",
      description: "Per-route p95 over a $__rate_interval window, bounded by topk(10). This is the slowest query in the set and the one exception to the recording-rule rule; keep the topk bound and the window short.",
      gridPos: { h: 8, w: 24, x: 0, y: 31 },
      targets: [
        {
          expr: `topk(10, histogram_quantile(0.95, sum by (le, route) (rate(vortex_http_request_duration_seconds_bucket{${SEL}}[$__rate_interval]))))`,
          legendFormat: "{{route}}",
        },
      ],
      unit: "s",
      decimals: 3,
      thresholds: LEVEL,
    }),

    row({ title: "Diagnostics", y: 39 }),
    timeseries({
      title: "Event loop utilisation (Loki)",
      description: "Node's own eventLoopUtilization diagnostics from the JSON log stream. The API can be slow with every Prometheus number green if the loop is blocked - this panel is why the observability profile ships Loki rather than Prometheus alone.",
      gridPos: { h: 7, w: 8, x: 0, y: 40 },
      ds: LOKI,
      targets: [{ expr: `{job=~"$job"} |= "eventLoopUtilization" | json | unwrap utilization`, legendFormat: "{{instance}}" }],
      unit: "percentunit",
      decimals: 3,
      thresholds: TH(0.7, 0.9),
      dashed: true,
    }),
    timeseries({
      title: "Instrumented routes",
      description: "Distinct route label values reporting request metrics. A newly added route that is not instrumented is invisible to every other panel here, so this is the panel that catches the blind spot. Expect a flat line; a step up means a route was added and instrumented.",
      gridPos: { h: 7, w: 8, x: 8, y: 40 },
      targets: [
        { expr: `count(count by (route) (vortex_http_requests_total{${SEL_TOT}}))`, legendFormat: "routes" },
      ],
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Shadow queue depth (relay)",
      description: "Bounded queue of pending shadow-mode observations. It belongs to the relay rather than the API, included here because queue saturation on this same box is what turns a slow downstream call into a dropped comparison.",
      gridPos: { h: 7, w: 8, x: 16, y: 40 },
      targets: [{ expr: "vortex:shadow:queue_depth", legendFormat: "queue depth" }],
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),
  ],
);

// ---------------------------------------------------------------------------
// 2. Intent lifecycle funnel
// ---------------------------------------------------------------------------

add(
  DASH(
    "Vortex - Intent lifecycle funnel",
    "vortex-intent-funnel",
    ["vortex", "intents"],
    "open -> accepted -> {filled, cancelled, expired, slashed}. Every number is a vortex:intent:* recording rule, so the 7-day range is cheap. Read the ratio row: a terminal_ratio well below 1.0 means intents are accumulating in a non-terminal state.",
  ),
  [
    row({ title: "Volume", y: 0 }),
    timeseries({
      title: "Intents opened/s",
      description: "Transitions into the open state per second. This is the denominator for every ratio on this dashboard, so if it is flat while user-visible traffic is not, the instrumentation is the suspect.",
      gridPos: { h: 7, w: 8, x: 0, y: 1 },
      targets: [{ expr: "vortex:intent:opened_per_second_5m", legendFormat: "opened" }],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Intents accepted/s",
      description: "Transitions open -> accepted per second. Solver supply indicator: this is the rate at which solvers pick intents up.",
      gridPos: { h: 7, w: 8, x: 8, y: 1 },
      targets: [{ expr: "vortex:intent:accepted_per_second_5m", legendFormat: "accepted" }],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Intents filled/s",
      description: "Transitions accepted -> filled per second. Settlement is the outcome users care about; compare against the on-chain confirms/s panel to spot the gap between internal and on-chain state.",
      gridPos: { h: 7, w: 8, x: 16, y: 1 },
      targets: [{ expr: "vortex:intent:filled_per_second_5m", legendFormat: "filled" }],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),

    row({ title: "Funnel conversion", y: 8 }),
    stat({
      title: "open -> accepted",
      description: "Share of newly opened intents that a solver picked up. Low here with healthy volume is a solver supply problem; low here with low volume is just a quiet period.",
      gridPos: { h: 5, w: 6, x: 0, y: 9 },
      expr: "vortex:intent:open_to_accepted_ratio_5m",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 3,
      thresholds: RATIO_HIGH_OK,
      dashed: true,
    }),
    stat({
      title: "accepted -> filled",
      description: "Share of accepted intents that settled. This is the number that decides whether the relay is actually working, and it is the one that moves when solver behaviour changes rather than solver supply.",
      gridPos: { h: 5, w: 6, x: 6, y: 9 },
      expr: "vortex:intent:accepted_to_filled_ratio_5m",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 3,
      thresholds: RATIO_HIGH_OK,
      dashed: true,
    }),
    stat({
      title: "terminal ratio",
      description: "Share of opened intents that reached any terminal state (filled|cancelled|expired|slashed). Below 1 over a window with real traffic means intents are piling up without resolving - the exact failure this dashboard exists to catch.",
      gridPos: { h: 5, w: 6, x: 12, y: 9 },
      expr: "vortex:intent:terminal_ratio_5m",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 3,
      thresholds: RATIO_HIGH_OK,
      dashed: true,
    }),
    stat({
      title: "Transitions/s",
      description: "All state transitions per second, any from -> to pair. Cross-check against the opened/s panel: more transitions than opens means intents are moving through several states at once.",
      gridPos: { h: 5, w: 6, x: 18, y: 9 },
      expr: `sum(rate(vortex_intent_state_transitions_total{${SEL_TOT}}[$__rate_interval]))`,
      legendFormat: "transitions/s",
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),

    row({ title: "Terminal states", y: 14 }),
    timeseries({
      title: "Terminal transitions/s by destination state",
      description: "Where intents actually end up. filled is the healthy outcome; cancelled is a user changing their mind; expired is the sweeper giving up on the fill window; slashed is a solver penalty.",
      gridPos: { h: 8, w: 12, x: 0, y: 15 },
      targets: [
        {
          expr: `sum by (to_state) (rate(vortex_intent_state_transitions_total{${SEL_TOT}, to_state=~"filled|cancelled|expired|slashed"}[$__rate_interval]))`,
          legendFormat: "{{to_state}}",
        },
      ],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
      stack: true,
    }),
    timeseries({
      title: "All transitions by from -> to",
      description: "The raw state machine as the service emits it. Use this to spot a transition that should not be happening at all - an unexpected pair here is a state-machine bug, not a performance problem.",
      gridPos: { h: 8, w: 12, x: 12, y: 15 },
      targets: [
        {
          expr: `sum by (from_state, to_state) (rate(vortex_intent_state_transitions_total{${SEL_TOT}}[$__rate_interval]))`,
          legendFormat: "{{from_state}} -> {{to_state}}",
        },
      ],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),

    row({ title: "Cumulative funnel", y: 23 }),
    timeseries({
      title: "Cumulative transitions per destination state",
      description: "increase() across the whole selected range, so the shape of the funnel is readable even when the absolute rates are too small to see. Counts of events in the range, not intents outstanding.",
      gridPos: { h: 8, w: 24, x: 0, y: 24 },
      targets: [
        {
          expr: `sum by (to_state) (increase(vortex_intent_state_transitions_total{${SEL_TOT}}[$__range]))`,
          legendFormat: "{{to_state}}",
        },
      ],
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
      stack: true,
    }),
  ],
);

// ---------------------------------------------------------------------------
// 3. On-chain pipeline — submit -> confirm, plus the shadow cutover gate
// ---------------------------------------------------------------------------

add(
  DASH(
    "Vortex - On-chain pipeline",
    "vortex-onchain-pipeline",
    ["vortex", "onchain", "slo"],
    "Submit -> confirm for every fill, plus the shadow-mode divergence monitor that gates the on-chain cutover (issue #401). Every number is a vortex:onchain:*, vortex:sweeper:* or vortex:shadow:* recording rule.",
  ),
  [
    row({ title: "Settlement", y: 0 }),
    stat({
      title: "Confirms/s",
      description: "On-chain confirmations per second (vortex:onchain:confirms_per_second_5m). Compare against vortex:intent:filled_per_second_5m on the funnel dashboard: the gap is the pipeline backlog.",
      gridPos: { h: 4, w: 6, x: 0, y: 1 },
      expr: "vortex:onchain:confirms_per_second_5m",
      legendFormat: "confirms/s",
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    stat({
      title: "Confirm p95",
      description: "Fill submission to on-chain confirmation, p95. Stellar finality is the floor here, so a 2 minute warn is a chain problem and a 5 minute bad value is a stuck submission.",
      gridPos: { h: 4, w: 6, x: 6, y: 1 },
      expr: "vortex:confirm:p95_5m",
      legendFormat: "p95",
      unit: "s",
      decimals: 1,
      thresholds: TH(120, 300),
      dashed: true,
    }),
    stat({
      title: "Ingestion lag",
      description: "Worst event-ingestion lag across targets. Rising ingestion lag makes confirmation latency look worse than it is, so check this before blaming the pipeline.",
      gridPos: { h: 4, w: 6, x: 12, y: 1 },
      expr: `max(vortex_event_ingestion_lag_seconds{${SEL_TOT}})`,
      legendFormat: "lag",
      unit: "s",
      decimals: 1,
      thresholds: TH(10, 30),
      dashed: true,
    }),
    stat({
      title: "Sweeper expiries/s",
      description: "Intents the sweeper expired. Sustained non-zero traffic past the deadline means the fill window is too tight for the chain's confirmation latency, not that users are giving up.",
      gridPos: { h: 4, w: 6, x: 18, y: 1 },
      expr: "vortex:sweeper:expired_per_second_5m",
      legendFormat: "expired/s",
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),

    row({ title: "Confirmation latency", y: 5 }),
    timeseries({
      title: "Confirm latency percentiles",
      description: "p50 and p99 fill-to-confirmation latency from the vortex:onchain:* recording rules, against the 2m/5m warn and bad lines.",
      gridPos: { h: 8, w: 12, x: 0, y: 6 },
      targets: [
        { expr: "vortex:onchain:confirm_p50_5m", legendFormat: "p50" },
        { expr: "vortex:onchain:confirm_p99_5m", legendFormat: "p99" },
      ],
      unit: "s",
      decimals: 1,
      thresholds: TH(120, 300),
      dashed: true,
    }),
    timeseries({
      title: "Sweeper sweep duration p95",
      description: "Duration of each IntentsSweeperService.sweep() call, recorded in milliseconds by the service. The unit here is ms and the recording rule is deliberately not normalised to seconds, so the numbers line up with the source.",
      gridPos: { h: 8, w: 12, x: 12, y: 6 },
      targets: [{ expr: "vortex:sweeper:sweep_p95_5m", legendFormat: "sweep p95" }],
      unit: "ms",
      decimals: 0,
      thresholds: TH(250, 1000),
      dashed: true,
    }),
    timeseries({
      title: "Event ingestion lag by instance",
      description: "Ingestion lag split by target, so a single slow indexer is visible instead of being averaged away. The first thing to check when Confirm p95 climbs with no corresponding traffic change.",
      gridPos: { h: 8, w: 24, x: 0, y: 14 },
      targets: [
        {
          expr: `vortex_event_ingestion_lag_seconds{${SEL_TOT}, instance=~"$instance"}`,
          legendFormat: "{{instance}}",
        },
      ],
      unit: "s",
      decimals: 1,
      thresholds: TH(10, 30),
      dashed: true,
    }),

    row({ title: "Shadow-mode divergence (cutover gate, issue #401)", y: 22 }),
    stat({
      title: "Divergence ratio (1h)",
      description: "sum(increase(divergences)) / sum(increase(comparisons)) over the last hour. This is the go/no-go number in docs/runbooks/onchain-cutover.md; a clean cutover needs it at zero for seven consecutive days.",
      gridPos: { h: 4, w: 6, x: 0, y: 23 },
      expr: "vortex:shadow:divergence_ratio_1h",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 5,
      thresholds: RATIO_LOW_OK,
      dashed: true,
    }),
    stat({
      title: "Comparisons (1h)",
      description: "How many (expected, simulated) pairs the monitor resolved. If this is 0 the monitor never ran, which is NOT the same as a clean result - the runbook requires at least 1000 comparisons per day before the ratio means anything.",
      gridPos: { h: 4, w: 6, x: 6, y: 23 },
      expr: "vortex:shadow:comparisons_1h",
      legendFormat: "comparisons",
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),
    stat({
      title: "Outcome mismatches (1h)",
      description: "Classified outcome_mismatch divergences, the one reason that is a hard no-go for the on-chain cutover while non-zero. Fires VortexShadowDivergenceDetected.",
      gridPos: { h: 4, w: 6, x: 12, y: 23 },
      expr: "vortex:shadow:outcome_mismatches_1h",
      legendFormat: "mismatches",
      unit: "short",
      decimals: 0,
      thresholds: ANY_BAD,
      dashed: true,
    }),
    stat({
      title: "Queue depth",
      description: "Pending shadow observations in the bounded queue. Non-zero depth together with a non-zero vortex_shadow_dropped_total means the divergence ratio is computed over a biased sample, so it cannot be used for the cutover decision.",
      gridPos: { h: 4, w: 6, x: 18, y: 23 },
      expr: "vortex:shadow:queue_depth",
      legendFormat: "queue depth",
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Divergence by transition and reason",
      description: "Divergences split by the transition that triggered them and the reason the classifier assigned. The transition tells you which code path is wrong; the reason tells you whether the off-chain side or the simulation is the suspect.",
      gridPos: { h: 8, w: 12, x: 0, y: 27 },
      targets: [
        {
          expr: `sum by (transition, reason) (rate(vortex_shadow_divergences_total{${SEL_TOT}}[$__rate_interval]))`,
          legendFormat: "{{transition}} / {{reason}}",
        },
      ],
      unit: "reqps",
      decimals: 4,
      thresholds: LEVEL,
      stack: true,
    }),
    timeseries({
      title: "Comparisons by expected vs simulated outcome",
      description: "Every comparison as the (expected, simulated) pair the issue asks for. The expected side is the off-chain verdict, so `ok -> rejected` (we committed what the contract would refuse) and `rejected -> ok` (we blocked what the contract would allow) are the two genuinely different bugs. outcome=unavailable means the simulation produced no verdict at all, which is neither agreement nor disagreement.",
      gridPos: { h: 8, w: 12, x: 12, y: 27 },
      targets: [
        {
          expr: `sum by (transition, expected, outcome) (rate(vortex_shadow_comparisons_total{${SEL_TOT}}[$__rate_interval]))`,
          legendFormat: "{{transition}}: {{expected}} -> {{outcome}}",
        },
      ],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
      stack: true,
    }),
  ],
);

// ---------------------------------------------------------------------------
// 4. Solver network
// ---------------------------------------------------------------------------

add(
  DASH(
    "Vortex - Solver network",
    "vortex-solver-network",
    ["vortex", "solvers"],
    "Solver supply and settlement behaviour: how much demand solvers absorb (open -> accepted), how much they complete (accepted -> filled) and what failure costs the network (slashes, expiries). Shares the vortex:intent:* recording rules with the funnel dashboard so the two can never disagree.",
  ),
  [
    row({ title: "Supply vs demand", y: 0 }),
    stat({
      title: "Accept rate",
      description: "Intents per second moving open -> accepted. This is solver capacity: it is a rate the solver set controls, so a shortfall here is a supply problem rather than a bug.",
      gridPos: { h: 4, w: 6, x: 0, y: 1 },
      expr: "vortex:intent:accepted_per_second_5m",
      legendFormat: "accepted/s",
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    stat({
      title: "Fill rate",
      description: "Intents per second moving accepted -> filled. Output, not willingness: a healthy accept rate with a low fill rate means solvers are taking intents they are not finishing.",
      gridPos: { h: 4, w: 6, x: 6, y: 1 },
      expr: "vortex:intent:filled_per_second_5m",
      legendFormat: "filled/s",
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    stat({
      title: "open -> accepted",
      description: "Share of opened intents picked up by a solver. Below 90% during real traffic means the solver set cannot absorb current demand and intents will expire unmet.",
      gridPos: { h: 4, w: 6, x: 12, y: 1 },
      expr: "vortex:intent:open_to_accepted_ratio_5m",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 3,
      thresholds: RATIO_HIGH_OK,
      dashed: true,
    }),
    stat({
      title: "accepted -> filled",
      description: "Completion quality after acceptance. Solvers that accept and never fill move this even when the accept rate looks healthy, which makes it the more diagnostic of the two ratios.",
      gridPos: { h: 4, w: 6, x: 18, y: 1 },
      expr: "vortex:intent:accepted_to_filled_ratio_5m",
      legendFormat: "ratio",
      unit: "percentunit",
      decimals: 3,
      thresholds: RATIO_HIGH_OK,
      dashed: true,
    }),

    row({ title: "Solver behaviour", y: 5 }),
    timeseries({
      title: "Accepted vs filled per second",
      description: "Supply and output on one axis. A widening gap between the two lines is the aggregate signature of solvers accepting work they do not settle, and it is the reason the accepted -> filled ratio is the panel to watch.",
      gridPos: { h: 8, w: 12, x: 0, y: 6 },
      targets: [
        { expr: "vortex:intent:accepted_per_second_5m", legendFormat: "accepted" },
        { expr: "vortex:intent:filled_per_second_5m", legendFormat: "filled" },
      ],
      unit: "reqps",
      decimals: 3,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Slashes/s",
      description: "Solvers slasher for missing the fill window. Sustained non-zero slashes alongside a low accepted -> filled ratio points at solver quality, not solver supply, and is a registry problem rather than an infrastructure one.",
      gridPos: { h: 8, w: 6, x: 12, y: 6 },
      targets: [{ expr: "vortex:intent:slashed_per_second_5m", legendFormat: "slashed/s" }],
      unit: "reqps",
      decimals: 4,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Expiries/s (sweeper)",
      description: "Intents the sweeper expired unfilled. Non-zero expiries with a healthy accept rate mean solvers accepted and lost the race, which is a latency problem rather than a supply problem.",
      gridPos: { h: 8, w: 6, x: 18, y: 6 },
      targets: [{ expr: "vortex:intent:expired_per_second_5m", legendFormat: "expired/s" }],
      unit: "reqps",
      decimals: 4,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Conversion ratios over time",
      description: "Both funnel ratios on one axis. They should move together; when accepted -> filled collapses on its own, the problem is solver behaviour rather than solver supply, and the fix is in the registry rather than in the relay.",
      gridPos: { h: 8, w: 12, x: 0, y: 14 },
      targets: [
        { expr: "vortex:intent:open_to_accepted_ratio_5m", legendFormat: "open -> accepted" },
        { expr: "vortex:intent:accepted_to_filled_ratio_5m", legendFormat: "accepted -> filled" },
      ],
      unit: "percentunit",
      decimals: 3,
      thresholds: RATIO_HIGH_OK,
      dashed: true,
    }),
    timeseries({
      title: "Cancellation vs expiry",
      description: "Two very different failure modes. Users cancelling is healthy - they changed their mind. The sweeper expiring them means nobody filled in time. If expiry overtakes cancellation, the fill window is too tight for the chain.",
      gridPos: { h: 8, w: 12, x: 12, y: 14 },
      targets: [
        { expr: "vortex:intent:cancelled_per_second_5m", legendFormat: "cancelled/s" },
        { expr: "vortex:intent:expired_per_second_5m", legendFormat: "expired/s" },
      ],
      unit: "reqps",
      decimals: 4,
      thresholds: LEVEL,
    }),

    row({ title: "Known gap: per-solver attribution", y: 22 }),
    text({
      title: "There is no per-solver panel here, and that is deliberate",
      description: "Explains why this dashboard stops at aggregate solver behaviour and where per-solver data does live.",
      gridPos: { h: 9, w: 24, x: 0, y: 23 },
      content: [
        "**No metric in this service carries a `solver` label, so there is no per-solver panel.**",
        "",
        "`vortex_intent_state_transitions_total` has `from_state` and `to_state` and nothing else.",
        "Adding `solver` would make cardinality proportional to the size of the solver registry, and",
        "a label whose value set can be grown by whoever registers a solver is a cardinality",
        "hazard, not a feature. The same reasoning applies to the per-route `topk` panels on the",
        "API dashboard: bounded, or not at all.",
        "",
        "**Where per-solver data actually lives**",
        "",
        "- `GET /api/v1/solvers/leaderboard` - the on-chain registry ranking, served by",
        "  `SolversService`. This is the authoritative per-solver view; it is a read of chain",
        "  state, not an aggregation of this service's counters.",
        "- The `accepted -> filled` ratio above is the aggregate proxy. Solvers that accept and",
        "  never fill move it even when total accept throughput looks healthy.",
        "",
        "**If a `solver` label is added** to `vortex_intent_state_transitions_total`, add a",
        "`topk(20, sum by (solver) (...))` panel here, bound the registry size in",
        "`src/metrics/metrics.service.ts` next to the metric definition, and re-check this",
        "dashboard against the 3s / 7-day budget before merging.",
      ].join("\n"),
    }),
  ],
);

// ---------------------------------------------------------------------------
// 5. WebSocket feed
// ---------------------------------------------------------------------------

add(
  DASH(
    "Vortex - WebSocket feed",
    "vortex-ws-feed",
    ["vortex", "websocket"],
    "Connection headroom and end-to-end delivery latency. Delivery p99 is the number a subscriber cares about; the connection gauge is the number an operator pages on.",
  ),
  [
    row({ title: "Connections", y: 0 }),
    stat({
      title: "Active connections",
      description: "Open WebSocket connections summed across targets (vortex:ws:connections). Compare against the configured WS_MAX_CONNECTIONS ceiling noted below - new sockets are refused at the ceiling, so this gauge pinned at its maximum is a capacity problem even though no error metric moves.",
      gridPos: { h: 4, w: 6, x: 0, y: 1 },
      expr: "vortex:ws:connections",
      legendFormat: "connections",
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),
    stat({
      title: "Delivery p95",
      description: "End-to-end delivery latency, broadcast to send, p95. The WS_MAX_CONNECTIONS ceiling has no metric because it is config and the gauge is runtime state; the two can drift apart silently, which is why headroom is annotated rather than thresholded.",
      gridPos: { h: 4, w: 6, x: 6, y: 1 },
      expr: "vortex:ws:p95_5m",
      legendFormat: "p95",
      unit: "s",
      decimals: 3,
      thresholds: TH(1, 2),
      dashed: true,
    }),
    stat({
      title: "Delivery p99",
      description: "End-to-end delivery latency p99. The gap between p95 and p99 is the tail that subscribers on a congested feed actually feel, and it is the number to quote when someone reports a stale stream.",
      gridPos: { h: 4, w: 6, x: 12, y: 1 },
      expr: "vortex:ws:p99_5m",
      legendFormat: "p99",
      unit: "s",
      decimals: 3,
      thresholds: TH(1, 2),
      dashed: true,
    }),
    stat({
      title: "Per-instance spread",
      description: "Largest per-target connection count minus the smallest. A non-zero spread on a multi-target deployment means load balancing is uneven, which shows up as some subscribers seeing a slower feed than the aggregate suggests.",
      gridPos: { h: 4, w: 6, x: 18, y: 1 },
      expr: `max(vortex_ws_connections_active{${SEL_TOT}}) - min(vortex_ws_connections_active{${SEL_TOT}})`,
      legendFormat: "spread",
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),

    row({ title: "Headroom", y: 5 }),
    timeseries({
      title: "Active connections",
      description: "The gauge over time. A step that never comes back down is a leak on the close path; a sawtooth that reaches the ceiling is refused connections, which the error metrics will not show because refusing is not an error.",
      gridPos: { h: 8, w: 12, x: 0, y: 6 },
      targets: [{ expr: "vortex:ws:connections", legendFormat: "active" }],
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),
    timeseries({
      title: "Active connections per instance",
      description: "The same gauge split by target, so an uneven load balancer is visible. Compare with the spread stat above before blaming the feed for uneven latency.",
      gridPos: { h: 8, w: 12, x: 12, y: 6 },
      targets: [
        {
          expr: `vortex_ws_connections_active{${SEL_TOT}, instance=~"$instance"}`,
          legendFormat: "{{instance}}",
        },
      ],
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),

    row({ title: "Delivery latency", y: 14 }),
    timeseries({
      title: "Delivery latency percentiles",
      description: "p50 and p99 end-to-end delivery latency from the vortex:ws:* recording rules, with the 1s/2s warn and bad lines drawn.",
      gridPos: { h: 8, w: 12, x: 0, y: 15 },
      targets: [
        { expr: "vortex:ws:p50_5m", legendFormat: "p50" },
        { expr: "vortex:ws:p99_5m", legendFormat: "p99" },
      ],
      unit: "s",
      decimals: 3,
      thresholds: TH(1, 2),
      dashed: true,
    }),
    timeseries({
      title: "WS connection churn",
      description: "Absolute change in connections per $__rate_interval. The gauge is an instantaneous level, so a client stuck in a reconnect loop looks perfectly stable; churn is what makes it visible.",
      gridPos: { h: 8, w: 12, x: 12, y: 15 },
      targets: [
        {
          expr: `abs(delta(vortex_ws_connections_active{${SEL_TOT}}[$__rate_interval]))`,
          legendFormat: "{{instance}}",
        },
      ],
      unit: "short",
      decimals: 0,
      thresholds: LEVEL,
    }),

    row({ title: "Configuring the ceiling", y: 23 }),
    text({
      title: "WS_MAX_CONNECTIONS is config, not a metric",
      description: "Why there is no ceiling line on the gauge above, and how to alert on headroom instead.",
      gridPos: { h: 7, w: 24, x: 0, y: 24 },
      content: [
        "**The gauge above has no ceiling line, on purpose.** `WS_MAX_CONNECTIONS` is read once at",
        "startup by `configuration.ts`; the gauge is incremented and decremented at runtime. Nothing",
        "exports the configured value, so a hardcoded line here would be a number that is right in",
        "local and wrong in production the first time anyone tunes the env var.",
        "",
        "- Default: `1000` (`.env.example:91`, `src/config/env.validation.ts:43`).",
        "- The application refuses new sockets at the ceiling rather than queueing them, so the",
        "  symptom is refused connections with no 5xx and no error counter moving.",
        "- **To alert on headroom instead of eyeballing the gauge**, set a Grafana-managed alert on",
        "  `vortex:ws:connections` with the threshold at your configured ceiling, or add an",
        "  exporting metric for the limit in `src/config/configuration.ts` and reference it here.",
      ].join("\n"),
    }),
  ],
);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const serialise = (dash) => JSON.stringify(dash, null, 2) + "\n";

function main() {
  const check = process.argv.includes("--check");

  if (check) {
    const problems = [];
    const expected = new Map(DASHBOARDS.map((d) => [d.uid + ".json", serialise(d)]));
    const actual = new Set(
      readdirSync(OUT_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f),
    );

    for (const [name, content] of expected) {
      if (!actual.has(name)) {
        problems.push(`missing ${name} - run: node ops/grafana/build.mjs`);
        continue;
      }
      if (readFileSync(join(OUT_DIR, name), "utf8") !== content) {
        problems.push(`${name} is out of date with build.mjs - run: node ops/grafana/build.mjs`);
      }
      actual.delete(name);
    }
    for (const stale of actual) {
      problems.push(`${stale} is not produced by build.mjs - delete it, or add it to the generator`);
    }

    if (problems.length > 0) {
      for (const p of problems) console.error(`  - ${p}`);
      console.error("");
      console.error(`${problems.length} dashboard(s) out of date.`);
      process.exit(1);
    }
    console.log(`OK: ${expected.size} dashboard(s) match build.mjs.`);
    return;
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  for (const dash of DASHBOARDS) {
    const name = `${dash.uid}.json`;
    writeFileSync(join(OUT_DIR, name), serialise(dash), { encoding: "utf8" });
    console.log(`wrote ${name} (${dash.panels.length} panels)`);
  }
}

main();
