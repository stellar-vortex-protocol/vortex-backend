/**
 * Chaos test runner.
 *
 * Orchestrates Toxiproxy toxic injection, service calls, assertions,
 * healing, and recovery assertions.  Produces a JSON report that the CI job
 * uploads as an artifact.
 *
 * Usage:
 *   CHAOS_BASE_URL=http://localhost:4000 \
 *   TOXIPROXY_URL=http://localhost:8474  \
 *   npx ts-node test/chaos/runner.ts
 *
 * The runner exits 1 if any scenario fails or recovery does not happen within
 * maxRecoveryMs; it exits 0 if all scenarios pass.
 */

import { CHAOS_SCENARIOS, ChaosScenario, ToxicConfig } from "./scenarios";

const BASE_URL    = process.env.CHAOS_BASE_URL    ?? "http://localhost:4000";
const TOXIPROXY   = process.env.TOXIPROXY_URL     ?? "http://localhost:8474";
const REPORT_PATH = process.env.CHAOS_REPORT_PATH ?? "test/chaos/report.json";

interface ScenarioResult {
  id: string;
  description: string;
  passed: boolean;
  faultAssertionPassed: boolean;
  recoveryPassed: boolean;
  faultStatusCodes: number[];
  recoveryMs: number;
  error?: string;
}

const results: ScenarioResult[] = [];

// ── Toxiproxy helpers ────────────────────────────────────────────────────────

async function addToxic(proxy: string, toxic: ToxicConfig, name: string): Promise<void> {
  const res = await fetch(`${TOXIPROXY}/proxies/${proxy}/toxics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      type: toxic.type,
      stream: toxic.stream,
      toxicity: toxic.toxicity,
      attributes: toxic.attributes,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add toxic ${name} to ${proxy}: ${res.status} ${text}`);
  }
}

async function removeToxic(proxy: string, name: string): Promise<void> {
  const res = await fetch(`${TOXIPROXY}/proxies/${proxy}/toxics/${name}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[chaos] Failed to remove toxic ${name} from ${proxy}: ${res.status}`);
  }
}

// ── Service helpers ───────────────────────────────────────────────────────────

/** Returns the HTTP status of GET /health/ready. */
async function healthStatus(): Promise<number> {
  try {
    const res = await fetch(`${BASE_URL}/health/ready`, { signal: AbortSignal.timeout(5_000) });
    return res.status;
  } catch {
    return 0; // connection refused / timeout
  }
}

/**
 * Attempt to create a minimal test intent and return the HTTP status.
 * The intent uses a dust amount that would normally trigger abuse scoring
 * but is recognisable as a chaos-test request via a header.
 */
async function createTestIntent(): Promise<number> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chaos-test": "1",    // allowlisted in ABUSE_ALLOWLIST if needed
      },
      body: JSON.stringify({
        user: "GCHAOSTEST000000000000000000000000000000000000000000000000",
        srcChain: "ethereum",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        srcTokenSymbol: "USDC",
        srcTokenDecimals: 6,
        srcAmount: "1000000",
        dstTokenContract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        dstTokenSymbol: "USDC",
        dstTokenDecimals: 7,
        minDstAmount: "9800000",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** Poll until health returns 2xx or timeout. Returns elapsed ms. */
async function waitForRecovery(maxMs: number): Promise<number> {
  const start = Date.now();
  const deadline = start + maxMs;
  while (Date.now() < deadline) {
    const status = await healthStatus();
    if (status >= 200 && status < 300) return Date.now() - start;
    await sleep(500);
  }
  return -1; // timed out
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScenario(scenario: ChaosScenario): Promise<ScenarioResult> {
  console.log(`\n[chaos] ▶ ${scenario.id}: ${scenario.description}`);

  const toxicNames: Array<{ proxy: string; name: string }> = [];
  const faultStatusCodes: number[] = [];
  let faultAssertionPassed = false;
  let recoveryPassed = false;
  let recoveryMs = 0;

  try {
    // ── 1. Inject ──────────────────────────────────────────────────────────
    let toxicIdx = 0;
    for (const proxy of scenario.proxies) {
      for (const toxic of scenario.toxics) {
        const name = `${scenario.id}-t${toxicIdx++}`;
        await addToxic(proxy, toxic, name);
        toxicNames.push({ proxy, name });
      }
    }

    // ── 2. Act ─────────────────────────────────────────────────────────────
    await sleep(200); // let toxic take effect

    for (let attempt = 0; attempt < 3; attempt++) {
      const status = await createTestIntent();
      faultStatusCodes.push(status);
    }

    // ── 3. Assert under fault ──────────────────────────────────────────────
    faultAssertionPassed = faultStatusCodes.every((s) =>
      scenario.expectedStatusUnderFault.includes(s),
    );
    console.log(
      `[chaos]   fault statuses: ${faultStatusCodes.join(", ")} — ${faultAssertionPassed ? "✓" : "✗"}`,
    );

    // ── 4. Heal ────────────────────────────────────────────────────────────
    for (const { proxy, name } of toxicNames) {
      await removeToxic(proxy, name);
    }
    toxicNames.length = 0;

    // ── 5. Assert recovery ─────────────────────────────────────────────────
    await sleep(500); // brief settle time
    recoveryMs = await waitForRecovery(scenario.maxRecoveryMs);
    recoveryPassed = recoveryMs >= 0;
    console.log(
      `[chaos]   recovery: ${recoveryPassed ? `${recoveryMs} ms ✓` : `TIMEOUT after ${scenario.maxRecoveryMs} ms ✗`}`,
    );

    const passed = faultAssertionPassed && recoveryPassed;
    return { id: scenario.id, description: scenario.description, passed, faultAssertionPassed, recoveryPassed, faultStatusCodes, recoveryMs };
  } catch (err) {
    console.error(`[chaos]   ERROR: ${(err as Error).message}`);
    return {
      id: scenario.id,
      description: scenario.description,
      passed: false,
      faultAssertionPassed,
      recoveryPassed,
      faultStatusCodes,
      recoveryMs,
      error: (err as Error).message,
    };
  } finally {
    // Always heal even if an assertion threw
    for (const { proxy, name } of toxicNames) {
      await removeToxic(proxy, name).catch(() => undefined);
    }
  }
}

async function main() {
  console.log(`[chaos] Running ${CHAOS_SCENARIOS.length} scenarios against ${BASE_URL}`);
  console.log(`[chaos] Toxiproxy: ${TOXIPROXY}\n`);

  // Run sequentially to avoid concurrent toxics interfering with each other
  for (const scenario of CHAOS_SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
    // Allow the service to fully settle between scenarios
    await sleep(2_000);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    total: results.length,
    passed,
    failed,
    scenarios: results,
  };

  const fs = await import("fs/promises");
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n[chaos] ══════════════════════════════════════`);
  console.log(`[chaos] Results: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`[chaos] Failed scenarios:`);
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ✗ ${r.id}: ${r.error ?? (r.faultAssertionPassed ? "recovery timeout" : "unexpected status codes")}`);
    });
  }
  console.log(`[chaos] Report written to ${REPORT_PATH}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[chaos] Fatal:", err);
  process.exit(1);
});
