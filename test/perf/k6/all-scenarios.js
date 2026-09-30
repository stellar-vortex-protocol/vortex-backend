/**
 * vortex-backend k6 performance suite — CI entry point
 *
 * Runs all four perf scenarios as named k6 scenarios in one process so a
 * single CI step produces a consolidated JSON summary.
 *
 * Usage:
 *   k6 run test/perf/k6/all-scenarios.js \
 *     --out json=test/perf/k6/results/raw-latest.json \
 *     -e K6_BASE_URL=http://localhost:4000
 *
 * The handleSummary export writes the machine-readable summary consumed by
 * test/perf/k6/scripts/compare-results.mjs.
 */

import http from 'k6/http';
import { sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  INTENT_BODY,
  QUOTE_BODY,
  JSON_HEADERS,
  checkResponse,
  isServerHealthy,
} from './lib/helpers.js';

// ── Custom metrics (shared across all scenarios) ─────────────────────────────
export const metrics = {
  intentsCreated: new Counter('perf_intents_created_total'),
  solverPolls:    new Counter('perf_solver_poll_total'),
  quotesRequested: new Counter('perf_quotes_requested_total'),
  lifecycleCompleted: new Counter('perf_lifecycle_completed_total'),

  createDuration:    new Trend('perf_intent_create_duration', true),
  pollDuration:      new Trend('perf_solver_poll_duration', true),
  quoteDuration:     new Trend('perf_quote_duration', true),
  lifecycleDuration: new Trend('perf_lifecycle_duration', true),
  readsDuration:     new Trend('perf_reads_duration', true),
};

// ── Scenario definitions ─────────────────────────────────────────────────────
export const options = {
  scenarios: {
    // ── Scenario A: Create-intent burst ──────────────────────────────────
    create_intent_burst: {
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: 5 },
        { duration: '30s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '10s', target: 0 },
      ],
      exec: 'createIntentBurst',
      tags: { scenario: 'create_intent_burst' },
    },

    // ── Scenario B: Solver polling ────────────────────────────────────────
    solver_polling: {
      executor: 'constant-vus',
      vus: 8,
      duration: '80s',
      exec: 'solverPolling',
      startTime: '5s',
      tags: { scenario: 'solver_polling' },
    },

    // ── Scenario C: Quote requests ────────────────────────────────────────
    quote_requests: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 8,
      maxVUs: 20,
      stages: [
        { duration: '10s', target: 5 },
        { duration: '30s', target: 12 },
        { duration: '20s', target: 12 },
        { duration: '10s', target: 0 },
      ],
      exec: 'quoteRequests',
      startTime: '5s',
      tags: { scenario: 'quote_requests' },
    },

    // ── Scenario D: Mixed read/write lifecycle ────────────────────────────
    mixed_lifecycle: {
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: 3 },
        { duration: '40s', target: 8 },
        { duration: '20s', target: 8 },
        { duration: '10s', target: 0 },
      ],
      exec: 'mixedLifecycle',
      startTime: '5s',
      tags: { scenario: 'mixed_lifecycle' },
    },
  },

  // ── Global thresholds (apply across all scenarios) ───────────────────────
  thresholds: {
    // Overall HTTP latency budget
    http_req_duration: [
      { threshold: 'p(95)<500', abortOnFail: false },
      { threshold: 'p(99)<1000', abortOnFail: false },
    ],
    // Per-scenario metric budgets
    perf_intent_create_duration:    ['p(95)<200', 'p(99)<400'],
    perf_solver_poll_duration:      ['p(95)<150', 'p(99)<300'],
    perf_quote_duration:            ['p(95)<200', 'p(99)<500'],
    perf_lifecycle_duration:        ['p(95)<600'],
    perf_reads_duration:            ['p(95)<150'],
    // Global error rate
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: false }],
    // Volume minimums (validates test ran meaningfully)
    perf_intents_created_total:     [{ threshold: 'count>50', abortOnFail: false }],
    perf_solver_poll_total:         [{ threshold: 'count>50', abortOnFail: false }],
    perf_quotes_requested_total:    [{ threshold: 'count>30', abortOnFail: false }],
    perf_lifecycle_completed_total: [{ threshold: 'count>15', abortOnFail: false }],
  },

  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// ── Setup ─────────────────────────────────────────────────────────────────────
export function setup() {
  if (!isServerHealthy()) {
    throw new Error(`Server at ${BASE_URL} is not healthy — aborting perf run`);
  }
  console.log(`k6 perf suite targeting ${BASE_URL}`);
}

// ── Scenario A: Create-intent burst ──────────────────────────────────────────
export function createIntentBurst() {
  const body = {
    ...INTENT_BODY,
    idempotencyKey: `k6-burst-${__VU}-${__ITER}`,
  };

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/intents`,
    JSON.stringify(body),
    { headers: JSON_HEADERS },
  );
  metrics.createDuration.add(Date.now() - start);
  const ok = checkResponse(res, 'create-intent', 201);
  if (ok) metrics.intentsCreated.add(1);
  sleep(0.1);
}

// ── Scenario B: Solver polling ────────────────────────────────────────────────
export function solverPolling() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/v1/intents/open`);
  metrics.pollDuration.add(Date.now() - start);
  const ok = checkResponse(res, 'solver-poll', 200);
  if (ok) metrics.solverPolls.add(1);
  sleep(1 + Math.random());
}

// ── Scenario C: Quote requests ────────────────────────────────────────────────
export function quoteRequests() {
  const amounts = ['500000', '1000000', '5000000', '10000000'];
  const body = { ...QUOTE_BODY, srcAmount: amounts[__ITER % amounts.length] };

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/intents/quote`,
    JSON.stringify(body),
    { headers: JSON_HEADERS },
  );
  metrics.quoteDuration.add(Date.now() - start);
  const ok = checkResponse(res, 'quote', 201);
  if (ok) metrics.quotesRequested.add(1);
  sleep(0.05);
}

// ── Scenario D: Mixed read/write lifecycle ────────────────────────────────────
export function mixedLifecycle() {
  const cycleStart = Date.now();
  let intentId;

  group('create_intent', () => {
    const body = { ...INTENT_BODY, idempotencyKey: `k6-lc-${__VU}-${__ITER}` };
    const res = http.post(
      `${BASE_URL}/api/v1/intents`,
      JSON.stringify(body),
      { headers: JSON_HEADERS },
    );
    checkResponse(res, 'lc:create', 201);
    if (res.status === 201) {
      try { intentId = JSON.parse(res.body).intentId; } catch { /* ignore */ }
    }
  });

  sleep(0.05);

  group('poll_open', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/intents/open`);
    metrics.readsDuration.add(Date.now() - start);
    checkResponse(res, 'lc:poll', 200);
  });

  sleep(0.05);

  if (intentId) {
    group('read_intent', () => {
      const start = Date.now();
      const res = http.get(`${BASE_URL}/api/v1/intents/${intentId}`);
      metrics.readsDuration.add(Date.now() - start);
      checkResponse(res, 'lc:read', 200);
    });
  }

  sleep(0.05);

  group('quote', () => {
    const res = http.post(
      `${BASE_URL}/api/v1/intents/quote`,
      JSON.stringify(QUOTE_BODY),
      { headers: JSON_HEADERS },
    );
    checkResponse(res, 'lc:quote', 201);
  });

  sleep(0.05);

  group('stats', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/stats`);
    metrics.readsDuration.add(Date.now() - start);
    checkResponse(res, 'lc:stats', 200);
  });

  group('solvers', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/solvers`);
    metrics.readsDuration.add(Date.now() - start);
    checkResponse(res, 'lc:solvers', 200);
  });

  metrics.lifecycleDuration.add(Date.now() - cycleStart);
  if (intentId) metrics.lifecycleCompleted.add(1);
  sleep(0.2);
}

// ── Summary export for comparison script ──────────────────────────────────────
export function handleSummary(data) {
  const timestamp = new Date().toISOString();
  const summary = { ...data, timestamp, baseUrl: BASE_URL };
  return {
    stdout: '\n=== k6 vortex-backend perf suite complete ===\n',
    'test/perf/k6/results/all-scenarios-latest.json': JSON.stringify(summary, null, 2),
  };
}
