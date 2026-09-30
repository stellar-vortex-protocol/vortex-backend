/**
 * Scenario: create-intent burst
 *
 * Simulates a surge of user intent submissions against POST /api/v1/intents.
 * This is the hottest write path — every swap starts here.
 *
 * Budget (p95 ≤ 200 ms, p99 ≤ 400 ms, error rate < 1%, RPS ≥ 50):
 * See test/perf/k6/baselines/create-intent.json
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  INTENT_BODY,
  JSON_HEADERS,
  checkResponse,
  isServerHealthy,
} from '../lib/helpers.js';

// ── Custom metrics ──────────────────────────────────────────────────────────
const createdIntents = new Counter('perf_intents_created_total');
const intentCreateDuration = new Trend('perf_intent_create_duration', true);

// ── Test options ────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    burst: {
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: 5 },   // warm-up
        { duration: '30s', target: 20 },  // ramp to burst
        { duration: '30s', target: 20 },  // sustain burst
        { duration: '10s', target: 0 },   // ramp down
      ],
    },
  },

  thresholds: {
    // Primary latency budgets
    http_req_duration: [
      { threshold: 'p(95)<200', abortOnFail: false },
      { threshold: 'p(99)<400', abortOnFail: false },
    ],
    // Custom per-endpoint trend
    perf_intent_create_duration: [
      { threshold: 'p(95)<200', abortOnFail: false },
      { threshold: 'p(99)<400', abortOnFail: false },
    ],
    // Error rate must stay under 1%
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: false }],
    // Minimum throughput: at least 50 successful creates per scenario run
    perf_intents_created_total: [{ threshold: 'count>50', abortOnFail: false }],
  },

  // Output a machine-readable summary for the comparison script.
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// ── Setup: verify server is reachable ───────────────────────────────────────
export function setup() {
  if (!isServerHealthy()) {
    throw new Error(`Server at ${BASE_URL} is not healthy — aborting perf run`);
  }
}

// ── Default function: one VU iteration ──────────────────────────────────────
export default function createIntentScenario() {
  // Use a unique idempotency key per VU + iteration to avoid dedup skipping
  const body = {
    ...INTENT_BODY,
    idempotencyKey: `k6-burst-${__VU}-${__ITER}`,
  };

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/intents`,
    JSON.stringify(body),
    { headers: JSON_HEADERS, tags: { scenario: 'create_intent_burst' } },
  );
  intentCreateDuration.add(Date.now() - start);

  const ok = checkResponse(res, 'create-intent', 201);
  if (ok) createdIntents.add(1);

  // Minimal think-time to avoid pure CPU spin
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    'test/perf/k6/results/create-intent-latest.json': JSON.stringify(data, null, 2),
  };
}
