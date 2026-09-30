# Chaos Test Suite

Tests the resilience of vortex-backend by injecting faults via [Toxiproxy](https://github.com/Shopify/toxiproxy).

## Running locally

```bash
# 1. Start the chaos stack (app-chaos + toxiproxy + postgres + redis)
docker compose --profile chaos up -d

# 2. Wait for the app to be healthy
curl -f http://localhost:4002/health/ready

# 3. Run all scenarios
CHAOS_BASE_URL=http://localhost:4002 \
TOXIPROXY_URL=http://localhost:8474  \
CHAOS_REPORT_PATH=test/chaos/report.json \
npx ts-node test/chaos/runner.ts
```

## Scenario list

See `test/chaos/scenarios.ts` for all 12 scenarios.  Each follows the DSL:

```
inject → act → assert → heal → assert recovery
```

| ID | Target | Fault | Expected under fault |
|---|---|---|---|
| `rpc-timeout` | Soroban RPC | 30 s latency | 200/201 (shadow async) |
| `rpc-stale-ledger` | Soroban RPC | 500 ms latency | 200 |
| `rpc-outage` | Soroban RPC | TCP timeout | 200/201 |
| `postgres-slow` | Postgres | 200 ms latency | 200/201/503 |
| `postgres-outage` | Postgres | TCP reset | 503 |
| `redis-outage` | Redis | TCP reset | 200/201 |
| `redis-bandwidth` | Redis | 10 KB/s cap | 200/201 |
| `horizon-slow` | Horizon | 5 s latency | 200/201 |
| `partial-partition` | Postgres | 50% packet drop | 200/201/503 |
| `soroban-reset` | Soroban RPC | TCP RST | 200/201 |
| `soroban-slow-close` | Soroban RPC | 10 s FIN delay | 200/201 |
| `compound-degradation` | Redis + Postgres | 100 ms latency each | 200/201/503 |

## CI

See `.github/workflows/chaos.yml` — runs weekly on a schedule and on manual dispatch.

## Determinism

- Each scenario seeds its own test intent (chaos-test address allowlisted).
- Toxics are always removed in a `finally` block so a failed scenario cannot leave the proxy broken.
- Retries are documented per scenario in `scenarios.ts`; the runner itself does not silently retry.
