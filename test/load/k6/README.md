# WebSocket Load Testing with k6 (Activity 4)

Distributed load testing harness for the Vortex WebSocket feed using k6 and xk6-websockets.

## Prerequisites

```bash
# Install k6 (macOS)
brew install k6

# Install k6 (Linux)
wget https://github.com/grafana/k6/releases/download/v0.47.0/k6-v0.47.0-linux-amd64.tar.gz
tar -xzf k6-v0.47.0-linux-amd64.tar.gz
sudo mv k6-v0.47.0-linux-amd64/k6 /usr/local/bin/

# Install k6 (Windows)
choco install k6
```

## Test Scenarios

### 1. Idle Subscribers (Baseline)

Measures baseline resource usage with connections doing nothing.

```bash
k6 run --vus 1000 --duration 5m \
  --env SCENARIO=idle \
  --env WS_URL=ws://localhost:4000/ws \
  test/load/k6/ws-capacity.js
```

**Expected metrics:**
- Memory per connection: ~8 KB
- CPU usage: < 5%
- p99 latency: < 50ms

### 2. Filtered Subscribers (Capability Matching)

Tests solver capability filtering under load.

```bash
k6 run --vus 1000 --duration 5m \
  --env SCENARIO=filtered \
  --env WS_URL=ws://localhost:4000/ws \
  test/load/k6/ws-capacity.js
```

**Expected metrics:**
- CPU usage: 10-20% (filtering overhead)
- p99 latency: < 100ms
- Filtered events: > 50% (depends on solver capabilities)

### 3. Reconnect Storm

Simulates mass reconnects during deploy/restart.

```bash
k6 run --vus 5000 --duration 2m \
  --env SCENARIO=reconnect \
  --env WS_URL=ws://localhost:4000/ws \
  test/load/k6/ws-capacity.js
```

**Expected metrics:**
- Reconnect time p99: < 2s
- No connection rejections (429/503)
- Server stays responsive

### 4. Replay Storm

Tests replay buffer performance under heavy concurrent replay requests.

```bash
k6 run --vus 1000 --duration 3m \
  --env SCENARIO=replay \
  --env WS_URL=ws://localhost:4000/ws \
  test/load/k6/ws-capacity.js
```

**Expected metrics:**
- Replay latency p99: < 500ms
- Memory growth: < 100 MB
- No OOM errors

## MessagePack Encoding Tests

Compare JSON vs MessagePack bandwidth:

```bash
# JSON baseline
k6 run --vus 1000 --duration 5m \
  --env SCENARIO=idle \
  --env ENCODING=json \
  test/load/k6/ws-capacity.js

# MessagePack (3x bandwidth reduction)
k6 run --vus 1000 --duration 5m \
  --env SCENARIO=idle \
  --env ENCODING=msgpack \
  test/load/k6/ws-capacity.js
```

Monitor egress bandwidth:
```bash
# On Linux
ifstat -i eth0 1

# On macOS
nettop -m tcp
```

## CI Integration

Reduced scale for CI pipelines:

```bash
k6 run --vus 100 --duration 1m \
  --env SCENARIO=idle \
  --summary-export=test-results.json \
  test/load/k6/ws-capacity.js
```

GitHub Actions workflow:
```yaml
- name: k6 WS load test
  run: |
    npm run build
    npm start &
    sleep 5
    k6 run --vus 100 --duration 1m test/load/k6/ws-capacity.js
```

## Capacity Model

Based on benchmark results (see `docs/benchmarks/ws-encoding-benchmark.md`):

| Pod Size     | Max Connections | Memory | CPU  | p99 Latency |
|--------------|-----------------|--------|------|-------------|
| 2 vCPU/4GB   | 5,000           | 3.5 GB | 80%  | 120ms       |
| 4 vCPU/8GB   | 10,000          | 7.0 GB | 70%  | 100ms       |
| 8 vCPU/16GB  | 25,000          | 14 GB  | 60%  | 80ms        |

**Recommended config for production:**
- WS_MAX_CONNECTIONS=10000 (4 vCPU pods)
- WS_BACKPLANE=redis (for horizontal scaling)
- Auto-scaling threshold: 7,000 connections per pod

## OS Limits

Ensure adequate file descriptors and ephemeral ports:

```bash
# Check current limits
ulimit -n

# Increase (add to /etc/security/limits.conf)
* soft nofile 65536
* hard nofile 65536

# Ephemeral port range (Linux)
sysctl net.ipv4.ip_local_port_range="1024 65535"

# Connection tracking (Linux)
sysctl net.netfilter.nf_conntrack_max=1000000
```

## Distributed Testing

For 50k+ connections, use k6 Cloud or distributed mode:

```bash
# Split load across 5 agents
k6 run --vus 10000 --duration 10m \
  --execution-segment "0:1/5" \
  test/load/k6/ws-capacity.js &

k6 run --vus 10000 --duration 10m \
  --execution-segment "1/5:2/5" \
  test/load/k6/ws-capacity.js &

# ... repeat for 3/5, 4/5, 5/5
```

## Monitoring

Key metrics to watch during tests:

```bash
# Prometheus queries
rate(vortex_ws_broadcast_duration_seconds_sum[5m])
vortex_ws_connections_active
histogram_quantile(0.99, rate(vortex_ws_delivery_latency_seconds_bucket[5m]))

# Grafana dashboard
open http://localhost:3000/d/vortex-ws-feed
```

## Troubleshooting

### Connection refused / EADDRNOTAVAIL
- Increase ephemeral port range
- Add delays between reconnects
- Use multiple client IPs

### High p99 latency spikes
- Check GC pauses (node --expose-gc)
- Profile with `node --prof`
- Reduce WS_OUTBOUND_QUEUE_MAX

### Memory growth
- Monitor replay buffer size
- Check for slow consumers (should disconnect)
- Review encoding cache eviction
