/**
 * CLI tests (issue #452): argument handling, fixture replay, sweep mode,
 * synthetic generation, and the `--json` report dump.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, USAGE } from "./cli";

const FIXTURES = join(__dirname, "fixtures");
const INTENTS = join(FIXTURES, "sample-intents.jsonl");
const PRICES = join(FIXTURES, "sample-prices.jsonl");

describe("runCli (issue #452)", () => {
  it("prints usage and exits 0 for --help", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(USAGE);
    expect(result.stdout).toContain("--sweep");
  });

  it("requires an input source", () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--input <path> or --generate <n> is required");
  });

  it("rejects unknown flags with usage", () => {
    const result = runCli(["--nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Usage:");
  });

  it("replays the fixture with the default margin strategy", () => {
    const result = runCli(["--input", INTENTS, "--prices", PRICES]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Strategy:           margin-threshold");
    expect(result.stdout).toContain("fill rate 100.0%");
    expect(result.stdout).toContain("Slash risk:");
    expect(result.stdout).toContain("PnL:");
    expect(result.stdout).toContain("unpriced fills: 0");
  });

  it("fills everything with the always-fill strategy", () => {
    const result = runCli(["--input", INTENTS, "--prices", PRICES, "--strategy", "always"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Strategy:           always-fill");
    expect(result.stdout).toContain("6 submitted, 0 declined");
  });

  it("declines everything above a hostile margin threshold", () => {
    const result = runCli([
      "--input",
      INTENTS,
      "--prices",
      PRICES,
      "--strategy",
      "margin",
      "--min-margin-bps",
      "1000",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Filled:            0");
    expect(result.stdout).toContain("6 declined");
  });

  it("rejects unknown strategies", () => {
    const result = runCli(["--input", INTENTS, "--strategy", "yolo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('unknown strategy "yolo"');
  });

  it("runs a fill-window × fee-bps sweep as a markdown table", () => {
    const result = runCli(["--input", INTENTS, "--prices", PRICES, "--sweep"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("| fill window (s) | fee bps |");
    expect(result.stdout).toContain("| 60 | 0 |");
    expect(result.stdout).toContain("| 300 | 10 |");
    // Default grid: 3 windows × 3 fee levels.
    const dataRows = result.stdout.split("\n").filter((line) => /^\| \d/.test(line));
    expect(dataRows).toHaveLength(9);
  });

  it("honours explicit sweep axes", () => {
    const result = runCli([
      "--input",
      INTENTS,
      "--sweep",
      "--fill-windows",
      "0,60",
      "--fee-bps-list",
      "5",
    ]);
    expect(result.exitCode).toBe(0);
    const dataRows = result.stdout.split("\n").filter((line) => /^\| \d/.test(line));
    expect(dataRows).toHaveLength(2);
  });

  it("rejects a malformed sweep axis", () => {
    const result = runCli(["--input", INTENTS, "--sweep", "--fill-windows", "abc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("--fill-windows: not a number: abc");
  });

  it("generates a synthetic archive with --generate", () => {
    const result = runCli(["--generate", "500", "--strategy", "always"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Events:            500");
    expect(result.stdout).toContain("fill rate 100.0%");
  });

  it("validates --generate input", () => {
    // "--generate -5" is rejected by parseArgs as ambiguous; the "=" form
    // reaches our own non-negative-integer validation.
    const result = runCli(["--generate=-5"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("--generate needs a non-negative integer");
  });

  it("reports missing input files", () => {
    const result = runCli(["--input", join(FIXTURES, "does-not-exist.jsonl")]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ENOENT");
  });

  it("writes the report JSON when --json is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-harness-"));
    const outPath = join(dir, "report.json");
    try {
      const result = runCli(["--input", INTENTS, "--prices", PRICES, "--json", outPath]);
      expect(result.exitCode).toBe(0);
      expect(result.jsonPath).toBe(outPath);
      expect(result.stdout).toContain(`report JSON written to ${outPath}`);
      const report = JSON.parse(readFileSync(outPath, "utf8"));
      expect(report.strategy).toBe("margin-threshold");
      expect(report.totals.filled).toBe(6);
      expect(report.params.seed).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes sweep JSON as a comparative report", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-harness-"));
    const outPath = join(dir, "sweep.json");
    try {
      const result = runCli([
        "--input",
        INTENTS,
        "--prices",
        PRICES,
        "--sweep",
        "--json",
        outPath,
      ]);
      expect(result.exitCode).toBe(0);
      const sweep = JSON.parse(readFileSync(outPath, "utf8"));
      expect(sweep.rows).toHaveLength(9);
      expect(sweep.strategy).toBe("margin-threshold");
      expect(sweep.seed).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
