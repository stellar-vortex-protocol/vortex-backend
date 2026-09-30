/**
 * k6 WebSocket capacity test (Activity 4)
 * 
 * Scenarios:
 * 1. Idle subscribers (baseline memory/CPU)
 * 2. Filtered subscribers (capability matching load)
 * 3. Reconnect storm (connection churn)
 * 4. Replay storm (high replay buffer usage)
 * 
 * Usage:
 *   # Local test (1k connections)
 *   k6 run --vus 1000 --duration 5m test/load/k6/ws-capacity.js
 * 
 *   # CI test (reduced scale)
 *   k6 run --vus 100 --duration 1m test/load/k6/ws-capacity.js
 * 
 *   # Full capacity test (50k connections, requires distributed k6)
 *   k6 run --vus 50000 --duration 10m test/load/k6/ws-capacity.js
 * 
 * Metrics:
 * - ws_connections_active (gauge)
 * - ws_delivery_latency_p99 (histogram)
 * - ws_messages_received (counter)
 * - ws_reconnect_time (histogram)
 * 
 * SLO: p99 delivery latency < 250ms at max capacity
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Gauge } from 'k6/metrics';

// Metrics
const wsConnections = new Gauge('ws_connections_active');
const wsDeliveryLatency = new Trend('ws_delivery_latency_ms');
const wsMessagesReceived = new Counter('ws_messages_received');
const wsReconnectTime = new Trend('ws_reconnect_time_ms');

// Configuration
const WS_URL = __ENV.WS_URL || 'ws://localhost:4000/ws';
const SCENARIO = __ENV.SCENARIO || 'idle'; // idle | filtered | reconnect | replay
const ENCODING = __ENV.ENCODING || 'json'; // json | msgpack

export const options = {
  scenarios: {
    [SCENARIO]: {
      executor: 'constant-vus',
      vus: __ENV.VUS || 100,
      duration: __ENV.DURATION || '1m',
    },
  },
  thresholds: {
    'ws_delivery_latency_ms': ['p(99)<250'], // SLO: p99 < 250ms
    'ws_connections_active': [],
    'ws_messages_received': [],
  },
};

export default function () {
  const protocol = ENCODING === 'msgpack' ? 'vortex.v1+msgpack' : undefined;
  const params = protocol ? { headers: { 'Sec-WebSocket-Protocol': protocol } } : {};

  const url = WS_URL;
  const startConnect = Date.now();

  const res = ws.connect(url, params, function (socket) {
    wsConnections.add(1);
    const connectTime = Date.now() - startConnect;

    socket.on('open', () => {
      console.log(`[${SCENARIO}] Connected in ${connectTime}ms (encoding=${ENCODING})`);
    });

    socket.on('message', (data) => {
      wsMessagesReceived.add(1);

      try {
        const msg = JSON.parse(data);

        // Measure delivery latency for broadcast events
        if (msg.type !== 'connected' && msg.type !== 'snapshot') {
          const now = Date.now();
          // Estimate server broadcast time from seq (not perfect but indicative)
          const latency = now - (msg.timestamp || now);
          if (latency > 0 && latency < 10000) {
            wsDeliveryLatency.add(latency);
          }
        }

        // Scenario-specific behavior
        if (SCENARIO === 'filtered' && msg.type === 'intent_created') {
          // Simulate solver processing
          sleep(0.01);
        }

        if (SCENARIO === 'replay' && msg.type === 'connected') {
          // Request replay immediately
          socket.send(JSON.stringify({ type: 'replay', fromSeq: Math.max(0, msg.seq - 100) }));
        }
      } catch (e) {
        console.error(`Failed to parse message: ${e}`);
      }
    });

    socket.on('close', () => {
      wsConnections.add(-1);
      console.log(`[${SCENARIO}] Disconnected`);
    });

    socket.on('error', (e) => {
      console.error(`[${SCENARIO}] WebSocket error: ${e}`);
    });

    // Keep connection alive for test duration
    if (SCENARIO === 'idle' || SCENARIO === 'filtered') {
      // Send heartbeat to keep connection alive
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: 'ping' }));
      }, 30000);
    }

    // Reconnect storm: disconnect and reconnect rapidly
    if (SCENARIO === 'reconnect') {
      sleep(Math.random() * 5); // Stagger disconnects
      socket.close();
      const reconnectStart = Date.now();
      wsReconnectTime.add(Date.now() - reconnectStart);
    }

    // For idle/filtered, wait for scenario duration
    if (SCENARIO === 'idle' || SCENARIO === 'filtered') {
      socket.setTimeout(() => {
        socket.close();
      }, (__ENV.DURATION || 60) * 1000);
    }
  });

  check(res, {
    'status is 101': (r) => r && r.status === 101,
  });

  // Reconnect delay for reconnect storm
  if (SCENARIO === 'reconnect') {
    sleep(Math.random() * 2 + 1);
  }
}
