# Grafana dashboards

Five dashboards for the Vortex relay, generated from source, provisioned into
Grafana on start, and linted in CI. This is issue #481.

```
node ops/grafana/build.mjs            # regenerate ops/grafana/dashboards/*.json
node ops/grafana/build.mjs --check    # fail if the committed JSON is stale (CI)
node ops/grafana/validate.mjs         # lint panels, metrics, alert links (CI)
```

## The dashboards

| File | UID | Answers |
| --- | --- | --- |
| `vortex-api-red.json` | `vortex-api-red` | Rate, Errors, Duration for the HTTP surface |
| `vortex-intent-funnel.json` | `vortex-intent-funnel` | open → accepted → {filled, cancelled, expired, slashed} |
| `vortex-onchain-pipeline.json` | `vortex-onchain-pipeline` | submit → confirm, ingestion lag, and the shadow-mode cutover gate |
| `vortex-solver-network.json` | `vortex-solver-network` | solver supply vs solver completion |
| `vortex-ws-feed.json` | `vortex-ws-feed` | connection headroom and delivery latency |

Every panel has a title, a description, a legend format, an explicit unit, and
a threshold set. Every panel either targets a `vortex:*` recording rule from
`ops/prometheus/rules/vortex-slo.yml` or runs a short-window raw query, and
`validate.mjs` fails the build if a panel names a metric that does not exist or
reintroduces a slow query shape.

## Why a generator, and not grafonnet

The issue offered Jsonnet/grafonnet, the Grafana Foundation SDK, or committed
JSON. The deciding factor was that a generator is only worth having if CI can
*run* it. `grafonnet` and `jsonnet` are not in this toolchain, and adding a
binary or a package is a heavier dependency than the problem deserves.

`build.mjs` and `validate.mjs` are plain ES modules using nothing outside
Node's standard library. The committed JSON is the artefact; the generator is
the thing CI can check it against. If the project later adopts grafonnet, these
two scripts become the migration harness: they already encode every constraint
the dashboards have to keep satisfying.

## Why almost every panel reads a recording rule

The issue's performance requirement is "dashboards must load < 3 s on 7-day
range". A panel running

```promql
histogram_quantile(0.99, sum(rate(vortex_http_request_duration_seconds_bucket[5m])) by (le))
```

over seven days has to pull roughly 120k samples per series and takes tens of
seconds. The `vortex:http:*` recording rules in `ops/prometheus/rules/vortex-slo.yml`
turn that into a single-series read.

Raw queries are still allowed where the breakdown *is* the point — the
per-route `topk(10, …)` panels on the API RED dashboard, for example — but
they must be bounded by `topk` and use `$__rate_interval` rather than a fixed
window. `validate.mjs` enforces exactly that distinction, so the cheap/dirty
line between the two kinds of panel cannot quietly move.

## What the linter actually checks

Each of these has a corresponding deliberate failure mode it exists to prevent:

| Check | Prevents |
| --- | --- |
| Every `vortex:*` is a defined `record:` | Dashboards full of "No data" after a recording rule is renamed |
| Every `vortex_*` is created in `metrics.service.ts` | Panels pointing at metrics that were never instrumented |
| Every panel has a unit | A seconds metric plotted as `short` — silently wrong, worse than broken |
| Every target has a `legendFormat` | A multi-series panel nobody can read |
| Descriptions are ≥ 20 characters | Panels titled "Errors" that explain nothing |
| `thresholdsStyle` is explicit, `dashed` needs ≥ 2 steps | Threshold lines that draw nothing, or invented SLOs for level readouts |
| No fixed window longer than 60s in a raw query | The 3 s / 7-day budget quietly regressing |
| `histogram_quantile` only under `topk(...)` | A whole-dashboard percentile over every route |
| No `rate()`/`increase()` over a `vortex:*` rule | Recording rules are already rate-aggregated; this is invalid PromQL |
| Datasource UIDs are declared in provisioning | Panels that render red on a fresh Grafana |
| Every alert has `dashboard_url`, and it resolves | A page that links nowhere to look |
| Every dashboard is linked from at least one alert | A dashboard nobody can find from a notification |
| `prometheus.yml`, provisioning, Compose profile exist | Dashboards that are not deployable |
| `build.mjs --check` | A hand-edited panel that the next regeneration reverts |

The linter was mutation-tested: each check above was confirmed to fail on a
deliberately broken dashboard, so a green run means something.

## Running the stack locally

```bash
docker compose --profile observability up -d
```

Grafana is on <http://localhost:3001> with anonymous viewing enabled
(`admin`/`admin` is the default password and is not used when anonymous access
is on). Prometheus is on <http://localhost:9090>.

The `app` service is scraped at `host.docker.internal:4000` from
`ops/prometheus/prometheus.yml`. Under a full-Compose setup, change that target
to `app:4000`.

**Anonymous access is for local use only.** The `grafana` service in
`docker-compose.yml` disables the login form. Do not copy that into a shared or
public deployment.

## Where `env` and `chain` come from

Nothing in the service emits `env` or `chain`. They are attached at ingest by
`metric_relabel_configs` in `ops/prometheus/prometheus.yml`, which is the only
place they can be added without touching instrumentation:

```yaml
metric_relabel_configs:
  - target_label: env
    replacement: local
  - target_label: chain
    replacement: testnet
```

The relabel block is repeated on the `prometheus` job as well, because `up` for
every target is emitted by *that* job — without it the "Targets up" panel
selects nothing.

Every other dashboard in this repo hardcodes the
`blob/main/ops/grafana/dashboards/...` path form in `dashboard_url`, so those
annotations stay correct after a branch is merged and the branch is deleted.
The same convention is used in `SECURITY.md` and the runbooks.

## Editing a dashboard

Do not edit `ops/grafana/dashboards/*.json` directly. Grafana is provisioned
with `allowUiUpdates: false`, so an edit made in the UI is reverted on the next
provisioning pass, and the next `node ops/grafana/build.mjs` overwrites the
file regardless.

Edit `build.mjs`, regenerate, and let CI confirm the result.

## Known gaps

- **No per-solver panel.** `vortex_intent_state_transitions_total` carries
  `from_state` and `to_state` only. Adding a `solver` label would make
  cardinality proportional to the size of the solver registry, and a label
  whose value set can be grown by whoever registers a solver is a cardinality
  hazard. Per-solver data lives at `GET /api/v1/solvers/leaderboard`. The
  solver dashboard explains this in a panel rather than silently omitting it.
- **Tempo is provisioned but idle.** The service emits no spans, so no
  committed dashboard queries traces. The datasource exists so that enabling
  tracing is a config change rather than a dashboard rebuild.
- **Loki backs exactly one panel** (event-loop utilisation on API RED). The
  rest of the stack is Prometheus, which is all the current metrics need.
- **`WS_MAX_CONNECTIONS` has no metric**, so the connection gauge has no ceiling
  line. The gauge is runtime state and the limit is config; hardcoding the
  default would be right locally and wrong in production the first time anyone
  tunes the env var. The WS dashboard says how to alert on headroom instead.
