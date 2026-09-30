# Synthetic canary (issue #496)

Runs the full intent lifecycle — **create → quote → accept → fill → confirm** —
with a dedicated canary user and solver, and pushes health metrics to a
Prometheus Pushgateway. Alerts live in `ops/prometheus/rules/vortex-canary.yml`.

```bash
npm run canary              # loop every CANARY_INTERVAL_MS
npm run canary -- --once    # single run, exit 1 on failure (CronJob / CI)
```

## Tagging

Canary traffic is identified by an **address registry**: list the canary user
and solver public keys in the backend's `CANARY_ADDRESSES`. The backend then

- excludes canary intents and the canary solver from `/api/v1/stats*` and the
  solver leaderboards, and
- only lets canary solvers accept canary intents (and vice versa), so real
  solvers' reputation and real users' fills are never affected.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CANARY_API_BASE` | `http://localhost:4000` | |
| `CANARY_NETWORK` | `testnet` | `testnet` \| `mainnet` |
| `CANARY_USER_SECRET` / `CANARY_SOLVER_SECRET` | — | required; dedicated keys only |
| `CANARY_INTERVAL_MS` | `300000` | loop period; also drives the failure alert |
| `CANARY_FILL_AMOUNT` | `1000000` | stroops of XLM per run |
| `CANARY_MAX_FILL_AMOUNT` | `1000000` | refuses to start above this; mainnet is also hard-capped at 1 XLM |
| `CANARY_SETTLE_ONCHAIN` | `true` | pay the fill on Stellar (solver → user, both canary-owned); `false` uses a synthetic tx hash (CI) |
| `CANARY_HORIZON_URL` | per network | |
| `CANARY_PUSHGATEWAY_URL` | unset | metrics are only pushed when set |
| `CANARY_MIN_BALANCE_XLM` | `5` | funds-depletion alert; mainnet runs stop below it |
| `CANARY_DAILY_BUDGET_XLM` | `1` | budget alert on 24 h balance drop |
| `CANARY_STEP_TIMEOUT_MS` | `60000` | per HTTP step and for confirm |

## Metrics

`vortex_canary_last_run_success`, `vortex_canary_last_success_timestamp_seconds`,
`vortex_canary_consecutive_failures`, `vortex_canary_step_duration_seconds{step}`,
`vortex_canary_balance_xlm`, plus the configured thresholds
(`interval_seconds`, `min_balance_xlm`, `daily_budget_xlm`), all labelled by
`network`.

## Deploy

`deploy/helm/vortex-canary` installs a CronJob (one run per tick,
`concurrencyPolicy: Forbid`). Build the image with
`docker build --target canary .` and provide the keys through the Secret named
in `existingSecret`. Install once per network, e.g.
`helm install canary-mainnet deploy/helm/vortex-canary --set network=mainnet`.
