/**
 * Scenario: quote requests — POST /api/v1/intents/quote
 *
 * Simulates frontend components calling the quote endpoint to display
 * estimated output amounts before a user commits an intent.
 *
 * Budget (p95 ≤ 200 ms, p99 ≤ 500 ms, error rate < 1%):
 * See test/perf/k6/baselines/quote-requests.json
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  QUOTE_BODY,
  JSON_HEADERS,
  checkResponse,
  isServerHealthy,
} from '../lib/helpers.js';

// ── Custom metrics ──────────────────────────────────────────────────────────
const quotesRequested = new Counter('perf_quotes_requested_total');
const quoteDuration = new Trend('perf_quote_duration', true);

// ── Test options ────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    quote_requests: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 30,
      stages: [
        { duration: '10s', target: 5 },
        { duration: '30s', target: 15 },
        { duration: '20s', target: 15 },
        { duration: '10s', target: 0 },
      ],
    },
  },

  thresholds: {
    http_req_duration: [
      { threshold: 'p(95)<200', abortOnFail: false },
      { threshold: 'p(99)<500', abortOnFail: false },
    ],
    perf_quote_duration: [
      { threshold: 'p(95)<200', abortOnFail: false },
      { threshold: 'p(99)<500', abortOnFail: false },
    ],
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: false }],
    perf_quotes_requested_total: [{ threshold: 'count>50', abortOnFail: false }],
  },

  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  if (!isServerHealthy()) {
    throw new Error(`Server at ${BASE_URL} is not healthy — aborting perf run`);
  }
}

// ── Default function ─────────────────────────────────────────────────────────
export default function quoteRequestsScenario() {
  // Vary the srcAmount to exercise different routing paths
  const amounts = ['500000', '1000000', '5000000', '10000000'];
  const amount = amounts[__ITER % amounts.length];

  const body = { ...QUOTE_BODY, srcAmount: amount };

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/intents/quote`,
    JSON.stringify(body),
    { headers: JSON_HEADERS, tags: { scenario: 'quote_requests' } },
  );
  quoteDuration.add(Date.now() - start);

  const ok = checkResponse(res, 'quote', 201);
  if (ok) quotesRequested.add(1);

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    'test/perf/k6/results/quote-requests-latest.json': JSON.stringify(data, null, 2),
  };
}
