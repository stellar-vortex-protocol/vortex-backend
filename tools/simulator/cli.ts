/**
 * CLI for the solver simulation harness (issue #452).
 *
 *   tsx tools/simulator/cli.ts --input archive.jsonl --strategy margin
 *   tsx tools/simulator/cli.ts --input archive.jsonl --sweep \
 *     --fill-windows 60,120,300 --fee-bps-list 0,5,10
 *   tsx tools/simulator/cli.ts --generate 100000 --strategy always
 *
 * Node's built-in `parseArgs` keeps the tool dependency-free. Nothing
 * here touches the network or the wall clock; reports are pure functions
 * of (archive, prices, strategy, params, seed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateSyntheticArchive, parseIntentEvents, parsePriceBook } from "./archive";
import { ReplayEngine } from "./engine";
import { formatReport, formatSweep } from "./report";
import { runSweep } from "./sweep";
import type { SweepGrid } from "./sweep";
import { AlwaysFillStrategy } from "./strategies/always-fill.strategy";
import { MarginThresholdStrategy } from "./strategies/margin-threshold.strategy";
import type { SimEvent, SimParams, SimulatorStrategy } from "./types";
import { DEFAULT_SIM_PARAMS } from "./types";

/** Usage text printed for `--help` and on argument errors. */
export const USAGE = [
  "Usage: tsx tools/simulator/cli.ts --input <intents.jsonl> [options]",
  "",
  "Inputs",
  "  --input <path>          archived intent events (JSONL, required unless --generate)",
  "  --prices <path>         archived price snapshots (JSONL)",
  "  --generate <n>          build a synthetic archive of n intents instead",
  "",
  "Strategy & params",
  "  --strategy <name>       always | margin (default: margin)",
  "  --min-margin-bps <n>    margin threshold (default: 0)",
  "  --auction               let the margin strategy wait for Dutch-auction decay",
  "  --seed <n>              PRNG seed (default: 42)",
  "  --fee-bps <n>           protocol fee bps (default: 5)",
  "  --fill-window <sec>     fill window from creation (default: deadline only)",
  "  --chains <a,b,c>        chain allowlist (default: all supported chains)",
  "  --slash-usd <n>         USD penalty per unfilled acceptance (default: 100)",
  "  --gas-usd <n>           USD cost per fill (default: 0)",
  "",
  "Sweep mode",
  "  --sweep                 replay across the parameter grid below",
  "  --fill-windows <a,b,c>  fill-window axis (default: 60,120,300)",
  "  --fee-bps-list <a,b,c>  fee-bps axis (default: 0,5,10)",
  "",
  "Output",
  "  --json <path>           also write the raw report JSON to a file",
  "  --help                  show this help",
].join("\n");

/** Outcome of a CLI invocation — pure data so tests can assert on it. */
export interface CliResult {
  stdout: string;
  exitCode: number;
  /** Destination of the `--json` dump, when requested. */
  jsonPath?: string;
}

/** Loose view of `parseArgs` values (string options + booleans). */
type CliValues = Record<string, string | boolean | undefined>;

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: string | boolean | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`not a number: ${String(value)}`);
  return parsed;
}

function numberList(raw: string, flag: string): number[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) throw new Error(`${flag} needs at least one number`);
  return parts.map((part) => {
    const value = Number(part);
    if (!Number.isFinite(value)) throw new Error(`${flag}: not a number: ${part}`);
    return value;
  });
}

function buildStrategy(name: string, params: SimParams, useAuction: boolean): SimulatorStrategy {
  if (name === "always") return new AlwaysFillStrategy({ chains: params.chains });
  if (name === "margin") {
    return new MarginThresholdStrategy({
      minMarginBps: params.minMarginBps,
      chains: params.chains,
      useAuction,
    });
  }
  throw new Error(`unknown strategy "${name}" (expected: always | margin)`);
}

/**
 * Run the CLI against an argv slice (without `node`/`script`).
 *
 * Never throws: argument, input and runtime errors become a message on
 * stdout with a non-zero exit code, so shells and tests can assert on the
 * result uniformly.
 */
export function runCli(argv: readonly string[]): CliResult {
  let values: CliValues;
  try {
    const parsed = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        input: { type: "string" },
        prices: { type: "string" },
        generate: { type: "string" },
        strategy: { type: "string" },
        "min-margin-bps": { type: "string" },
        auction: { type: "boolean" },
        seed: { type: "string" },
        "fee-bps": { type: "string" },
        "fill-window": { type: "string" },
        chains: { type: "string" },
        "slash-usd": { type: "string" },
        "gas-usd": { type: "string" },
        sweep: { type: "boolean" },
        "fill-windows": { type: "string" },
        "fee-bps-list": { type: "string" },
        json: { type: "string" },
        help: { type: "boolean" },
      },
    });
    values = parsed.values as unknown as CliValues;
  } catch (err) {
    return { stdout: `${(err as Error).message}\n\n${USAGE}`, exitCode: 2 };
  }

  if (values.help === true) return { stdout: USAGE, exitCode: 0 };

  try {
    const inputPath = asString(values.input);
    const pricesPath = asString(values.prices);
    const generate = asString(values.generate);
    const jsonPath = asString(values.json);
    const chainsRaw = asString(values.chains);
    const fillWindowsRaw = asString(values["fill-windows"]);
    const feeListRaw = asString(values["fee-bps-list"]);
    const strategyName = asString(values.strategy) ?? "margin";

    const params: SimParams = {
      ...DEFAULT_SIM_PARAMS,
      seed: asNumber(values.seed, DEFAULT_SIM_PARAMS.seed),
      feeBps: asNumber(values["fee-bps"], DEFAULT_SIM_PARAMS.feeBps),
      fillWindowSec: asNumber(values["fill-window"], DEFAULT_SIM_PARAMS.fillWindowSec),
      minMarginBps: asNumber(values["min-margin-bps"], DEFAULT_SIM_PARAMS.minMarginBps),
      slashPenaltyUsd: asNumber(values["slash-usd"], DEFAULT_SIM_PARAMS.slashPenaltyUsd),
      gasUsdPerFill: asNumber(values["gas-usd"], DEFAULT_SIM_PARAMS.gasUsdPerFill),
      chains:
        chainsRaw === undefined
          ? DEFAULT_SIM_PARAMS.chains
          : chainsRaw
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s !== ""),
    };

    let events: SimEvent[];
    if (generate !== undefined) {
      const count = Number(generate);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error("--generate needs a non-negative integer");
      }
      events = generateSyntheticArchive(count, params.seed);
    } else if (inputPath !== undefined) {
      events = parseIntentEvents(readFileSync(inputPath, "utf8"));
    } else {
      return { stdout: `--input <path> or --generate <n> is required\n\n${USAGE}`, exitCode: 2 };
    }

    const prices = pricesPath === undefined ? undefined : parsePriceBook(readFileSync(pricesPath, "utf8"));
    const useAuction = values.auction === true;

    let stdout: string;
    let jsonValue: unknown;
    if (values.sweep === true) {
      const grid: SweepGrid = {
        fillWindowSecs: fillWindowsRaw === undefined ? [60, 120, 300] : numberList(fillWindowsRaw, "--fill-windows"),
        feeBps: feeListRaw === undefined ? [0, 5, 10] : numberList(feeListRaw, "--fee-bps-list"),
      };
      const sweep = runSweep(events, {
        strategyFactory: (cellParams) => buildStrategy(strategyName, cellParams, useAuction),
        params,
        prices,
        grid,
      });
      stdout = formatSweep(sweep);
      jsonValue = sweep;
    } else {
      const strategy = buildStrategy(strategyName, params, useAuction);
      const report = new ReplayEngine({ strategy, params, prices }).run(events);
      stdout = formatReport(report);
      jsonValue = report;
    }

    const result: CliResult = { stdout, exitCode: 0 };
    if (jsonPath !== undefined) {
      writeFileSync(jsonPath, `${JSON.stringify(jsonValue, null, 2)}\n`, "utf8");
      result.jsonPath = jsonPath;
      result.stdout += `\n\nreport JSON written to ${jsonPath}`;
    }
    return result;
  } catch (err) {
    return { stdout: `${(err as Error).message}\n\n${USAGE}`, exitCode: 1 };
  }
}

/* istanbul ignore next -- process bootstrap, exercised by CLI runs */
if (require.main === module) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
