/**
 * Scenario: solver polling — GET /api/v1/intents/open
 *
 * Simulates the solver network continuously polling for new intents to accept.
 * This is a high-frequency read path; solvers poll every 1–5 s in production.
 *
 * Budget (p95 ≤ 150 ms, p99 ≤ 300 ms, error rate < 0.5%):
 * See test/perf/k6/baselines/solver-polling.json
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  checkResponse,
  isServerHealthy,
} from '../lib/helpers.js';

// ── Custom metrics ──────────────────────────────────────────────────────────
const pollRequests = new Counter('perf_solver_poll_total');
const pollDuration = new Trend('perf_solver_poll_duration', true);

// ── Test options ────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    solver_polling: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
    },
  },

  thresholds: {
    http_req_duration: [
      { threshold: 'p(95)<150', abortOnFail: false },
      { threshold: 'p(99)<300', abortOnFail: false },
    ],
    perf_solver_poll_duration: [
      { threshold: 'p(95)<150', abortOnFail: false },
      { threshold: 'p(99)<300', abortOnFail: false },
    ],
    http_req_failed: [{ threshold: 'rate<0.005', abortOnFail: false }],
    // Ensure meaningful volume: 10 VUs × 60s ÷ 2s sleep = ~300 polls
    perf_solver_poll_total: [{ threshold: 'count>100', abortOnFail: false }],
  },

  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  if (!isServerHealthy()) {
    throw new Error(`Server at ${BASE_URL} is not healthy — aborting perf run`);
  }
}

// ── Default function ─────────────────────────────────────────────────────────
export default function solverPollingScenario() {
  const start = Date.now();
  const res = http.get(
    `${BASE_URL}/api/v1/intents/open`,
    { tags: { scenario: 'solver_polling' } },
  );
  pollDuration.add(Date.now() - start);

  const ok = checkResponse(res, 'solver-poll /intents/open', 200);
  if (ok) pollRequests.add(1);

  // Simulate realistic solver polling interval (1–2 s)
  sleep(1 + Math.random());
}

export function handleSummary(data) {
  return {
    'test/perf/k6/results/solver-polling-latest.json': JSON.stringify(data, null, 2),
  };
}
