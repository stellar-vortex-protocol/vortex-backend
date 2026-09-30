/**
 * Synthetic canary (issue #496).
 *
 * Runs the full intent lifecycle — create → quote → accept → fill → confirm —
 * against a live API with dedicated canary user + solver keys, and reports
 * success, per-step latency and canary balance to a Prometheus Pushgateway.
 * Alerts are defined in ops/prometheus/rules/canary.rules.yml.
 *
 * The canary addresses must be listed in the backend's CANARY_ADDRESSES so
 * canary intents are excluded from public stats / leaderboards and can only be
 * accepted by the canary solver.
 *
 *   tsx tools/canary/canary.ts          # loop every CANARY_INTERVAL_MS
 *   tsx tools/canary/canary.ts --once   # single run (Kubernetes CronJob); exit 1 on failure
 *
 * See tools/canary/README.md for configuration.
 */
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import client from "prom-client";
import {
  buildAcceptMessage,
  buildFillMessage,
  buildRegisterMessage,
} from "../../src/common/stellar-signature";
import { STELLAR_TOKENS, SUPPORTED_TOKENS } from "../../src/tokens/tokens.data";

type Network = "testnet" | "mainnet";

/** Mainnet ceiling per run regardless of configuration: 1 XLM (in stroops). */
export const MAINNET_HARD_CAP_STROOPS = 10_000_000n;
const STROOPS_PER_XLM = 10_000_000;
const STEPS = ["create", "quote", "accept", "fill", "confirm"] as const;
type Step = (typeof STEPS)[number];

export interface CanaryConfig {
  apiBase: string;
  network: Network;
  userSecret: string;
  solverSecret: string;
  intervalMs: number;
  fillAmount: bigint;
  maxFillAmount: bigint;
  settleOnchain: boolean;
  horizonUrl: string;
  pushgatewayUrl?: string;
  minBalanceXlm: number;
  dailyBudgetXlm: number;
  stepTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CanaryConfig {
  const network = (env.CANARY_NETWORK ?? "testnet") as Network;
  if (network !== "testnet" && network !== "mainnet") throw new Error("CANARY_NETWORK must be testnet or mainnet");
  const config: CanaryConfig = {
    apiBase: env.CANARY_API_BASE ?? "http://localhost:4000",
    network,
    userSecret: env.CANARY_USER_SECRET ?? required("CANARY_USER_SECRET"),
    solverSecret: env.CANARY_SOLVER_SECRET ?? required("CANARY_SOLVER_SECRET"),
    intervalMs: Number(env.CANARY_INTERVAL_MS ?? 300_000),
    fillAmount: BigInt(env.CANARY_FILL_AMOUNT ?? "1000000"),
    maxFillAmount: BigInt(env.CANARY_MAX_FILL_AMOUNT ?? "1000000"),
    settleOnchain: (env.CANARY_SETTLE_ONCHAIN ?? "true") === "true",
    horizonUrl:
      env.CANARY_HORIZON_URL ??
      (network === "mainnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"),
    pushgatewayUrl: env.CANARY_PUSHGATEWAY_URL || undefined,
    minBalanceXlm: Number(env.CANARY_MIN_BALANCE_XLM ?? 5),
    dailyBudgetXlm: Number(env.CANARY_DAILY_BUDGET_XLM ?? 1),
    stepTimeoutMs: Number(env.CANARY_STEP_TIMEOUT_MS ?? 60_000),
  };
  assertValueCaps(config);
  return config;
}

/** Strict value caps: every run is bounded by CANARY_MAX_FILL_AMOUNT; mainnet also by a hard ceiling. */
export function assertValueCaps(config: Pick<CanaryConfig, "network" | "fillAmount" | "maxFillAmount">): void {
  if (config.fillAmount <= 0n) throw new Error("CANARY_FILL_AMOUNT must be positive");
  if (config.fillAmount > config.maxFillAmount) {
    throw new Error(`CANARY_FILL_AMOUNT ${config.fillAmount} exceeds CANARY_MAX_FILL_AMOUNT ${config.maxFillAmount}`);
  }
  if (config.network === "mainnet" && config.fillAmount > MAINNET_HARD_CAP_STROOPS) {
    throw new Error(`Mainnet canary fill ${config.fillAmount} exceeds hard cap ${MAINNET_HARD_CAP_STROOPS} stroops`);
  }
}

class Metrics {
  readonly registry = new client.Registry();
  private readonly labels: { network: Network };
  readonly lastRunSuccess: client.Gauge<string>;
  readonly lastSuccess: client.Gauge<string>;
  readonly consecutiveFailures: client.Gauge<string>;
  readonly stepDuration: client.Gauge<string>;
  readonly balance: client.Gauge<string>;

  constructor(private readonly config: CanaryConfig) {
    this.labels = { network: config.network };
    const gauge = (name: string, help: string, labelNames: string[] = ["network"]) =>
      new client.Gauge({ name: `vortex_canary_${name}`, help, labelNames, registers: [this.registry] });
    this.lastRunSuccess = gauge("last_run_success", "1 if the latest canary run succeeded, else 0");
    this.lastSuccess = gauge("last_success_timestamp_seconds", "Unix time of the latest successful canary run");
    this.consecutiveFailures = gauge("consecutive_failures", "Consecutive failed runs (loop mode)");
    this.stepDuration = gauge("step_duration_seconds", "Latency of each lifecycle step in the latest run", [
      "network",
      "step",
    ]);
    this.balance = gauge("balance_xlm", "Canary solver native balance in XLM");
    gauge("interval_seconds", "Configured run interval").set(this.labels, config.intervalMs / 1000);
    gauge("min_balance_xlm", "Funds-depletion alert threshold").set(this.labels, config.minBalanceXlm);
    gauge("daily_budget_xlm", "Maximum XLM the canary may consume per 24 h").set(
      this.labels,
      config.dailyBudgetXlm,
    );
  }

  recordRun(ok: boolean, durations: Partial<Record<Step, number>>, failures: number) {
    this.lastRunSuccess.set(this.labels, ok ? 1 : 0);
    if (ok) this.lastSuccess.set(this.labels, Math.floor(Date.now() / 1000));
    this.consecutiveFailures.set(this.labels, failures);
    for (const [step, seconds] of Object.entries(durations)) {
      this.stepDuration.set({ ...this.labels, step }, seconds);
    }
  }

  async push(): Promise<void> {
    if (!this.config.pushgatewayUrl) return;
    const gateway = new client.Pushgateway(this.config.pushgatewayUrl, {}, this.registry);
    // pushAdd keeps series this push omits (e.g. last_success after a failure).
    await gateway.pushAdd({ jobName: "vortex-canary", groupings: { network: this.config.network } });
  }
}

async function api<T>(config: CanaryConfig, method: string, path: string, body?: unknown): Promise<T> {
  // eslint-disable-next-line no-restricted-syntax -- standalone script, no HttpEgressService in scope
  const res = await fetch(`${config.apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.stepTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const sign = (kp: Keypair, message: string) => kp.sign(Buffer.from(message, "utf8")).toString("base64");

/** Ensures the canary solver is registered (idempotent). */
async function ensureSolver(config: CanaryConfig, solver: Keypair): Promise<void> {
  const address = solver.publicKey();
  try {
    await api(config, "GET", `/api/v1/solvers/${address}`);
  } catch {
    await api(config, "POST", "/api/v1/solvers", {
      address,
      name: "vortex-canary",
      bondAmount: config.fillAmount.toString(),
      avgFillTime: 5,
      supportedChains: ["ethereum", "stellar"],
      supportedTokens: ["USDC", "XLM"],
      proofSignature: sign(solver, buildRegisterMessage(address)),
    });
  }
}

/** Pays the fill amount in native XLM from solver to user; funds stay inside canary accounts. */
async function settleOnchain(config: CanaryConfig, solver: Keypair, user: string): Promise<string> {
  const horizon = new Horizon.Server(config.horizonUrl);
  const account = await horizon.loadAccount(solver.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: (await horizon.fetchBaseFee()).toString(),
    networkPassphrase: config.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: user,
        asset: Asset.native(),
        amount: (Number(config.fillAmount) / STROOPS_PER_XLM).toFixed(7),
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(solver);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

async function solverBalanceXlm(config: CanaryConfig, solver: Keypair): Promise<number | undefined> {
  if (!config.settleOnchain) return undefined;
  const account = await new Horizon.Server(config.horizonUrl).loadAccount(solver.publicKey());
  const native = account.balances.find((b) => b.asset_type === "native");
  return native ? Number(native.balance) : undefined;
}

/** One full lifecycle run; returns per-step latencies in seconds or throws on the failing step. */
export async function runOnce(
  config: CanaryConfig,
  durations: Partial<Record<Step, number>> = {},
): Promise<Partial<Record<Step, number>>> {
  const user = Keypair.fromSecret(config.userSecret);
  const solver = Keypair.fromSecret(config.solverSecret);
  const src = SUPPORTED_TOKENS.ethereum.find((t) => t.symbol === "USDC")!;
  const dst = STELLAR_TOKENS.find((t) => t.symbol === "XLM")!;
  const step = async <T>(name: Step, fn: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      durations[name] = (performance.now() - started) / 1000;
    }
  };

  await ensureSolver(config, solver);
  const runId = `canary-${Date.now()}`;

  const intent = await step("create", () =>
    api<{ intentId: string }>(config, "POST", "/api/v1/intents", {
      user: user.publicKey(),
      srcChain: "ethereum",
      srcTokenAddress: src.address,
      srcTokenSymbol: src.symbol,
      srcTokenDecimals: src.decimals,
      srcAmount: "1000000",
      dstTokenContract: dst.contract,
      dstTokenSymbol: dst.symbol,
      dstTokenDecimals: dst.decimals,
      minDstAmount: config.fillAmount.toString(),
      idempotencyKey: runId,
    }),
  );
  const id = intent.intentId;

  await step("quote", () =>
    api(config, "POST", "/api/v1/intents/quote", {
      srcChain: "ethereum",
      srcTokenSymbol: src.symbol,
      srcAmount: "1000000",
      dstTokenSymbol: dst.symbol,
      intentId: id,
    }),
  );

  await step("accept", () =>
    api(config, "POST", `/api/v1/intents/${id}/accept`, {
      solver: solver.publicKey(),
      signature: sign(solver, buildAcceptMessage(id, solver.publicKey())),
    }),
  );

  await step("fill", async () => {
    const txHash = config.settleOnchain ? await settleOnchain(config, solver, user.publicKey()) : `${runId}-synthetic`;
    await api(config, "POST", `/api/v1/intents/${id}/fill`, {
      solver: solver.publicKey(),
      fillAmount: config.fillAmount.toString(),
      txHash,
      signature: sign(solver, buildFillMessage(id, solver.publicKey())),
    });
  });

  await step("confirm", async () => {
    const deadline = Date.now() + config.stepTimeoutMs;
    for (;;) {
      const current = await api<{ state: string }>(config, "GET", `/api/v1/intents/${id}`);
      if (current.state === "filled") return;
      if (Date.now() > deadline) throw new Error(`intent ${id} still ${current.state} after fill`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  });

  return durations;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const metrics = new Metrics(config);
  const once = process.argv.includes("--once");
  const solver = Keypair.fromSecret(config.solverSecret);
  let failures = 0;

  for (;;) {
    const durations: Partial<Record<Step, number>> = {};
    let ok = false;
    try {
      const balance = await solverBalanceXlm(config, solver);
      if (balance !== undefined) {
        metrics.balance.set({ network: config.network }, balance);
        if (config.network === "mainnet" && balance < config.minBalanceXlm) {
          throw new Error(`canary balance ${balance} XLM below CANARY_MIN_BALANCE_XLM; refusing to spend on mainnet`);
        }
      }
      await runOnce(config, durations);
      ok = true;
      failures = 0;
      console.log(`[canary] ok ${JSON.stringify(durations)}`);
    } catch (err) {
      failures++;
      console.error(`[canary] FAILED (${failures} consecutive): ${(err as Error).message}`);
    }
    metrics.recordRun(ok, durations, failures);
    await metrics.push().catch((err) => console.error(`[canary] metrics push failed: ${err.message}`));

    if (once) process.exit(ok ? 0 : 1);
    await new Promise((r) => setTimeout(r, config.intervalMs));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[canary] fatal: ${err.message}`);
    process.exit(1);
  });
}
