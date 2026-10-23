/**
 * Per-record cost of the structured logger (issue #488).
 *
 *   npx tsx scripts/bench-logger.ts
 *
 * Writes N records through the full format pipeline (context lookup,
 * normalisation, redaction, JSON) into a no-op transport, inside a request
 * context, and reports µs/record and the implied CPU share at 1k rps with one
 * record per request. Console output is silenced so terminal I/O does not
 * dominate the measurement.
 */
import Transport from "winston-transport";
import { runWithLogContext } from "../src/common/log-context";
import { createLogger, logger } from "../src/common/logger";

class NullTransport extends Transport {
  log(_info: unknown, done: () => void): void {
    done();
  }
}

const N = Number(process.argv[2] ?? 50_000);

logger.transports.forEach((t) => (t.silent = true));
logger.add(new NullTransport());
logger.level = "info";

const log = createLogger("bench");

function run(label: string, fn: () => void): void {
  for (let i = 0; i < 1_000; i++) fn(); // warm-up
  const start = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn();
  const wallUs = Number(process.hrtime.bigint() - t0) / 1_000;
  const cpu = process.cpuUsage(start);
  const cpuUsPerRecord = (cpu.user + cpu.system) / N;
  // At 1k rps one record per request costs cpuUsPerRecord * 1000 µs per second.
  const cpuShareAt1kRps = (cpuUsPerRecord * 1_000) / 1_000_000;
  console.log(
    `${label.padEnd(28)} ${(wallUs / N).toFixed(2).padStart(7)} µs/record wall  ` +
      `${cpuUsPerRecord.toFixed(2).padStart(7)} µs/record cpu  ` +
      `${(cpuShareAt1kRps * 100).toFixed(2).padStart(5)}% of one core at 1k rps`,
  );
}

runWithLogContext({ requestId: "bench-request", intentId: "bench-intent" }, () => {
  run("info, 6 fields", () =>
    log.info("http request completed", {
      event: "http.request",
      method: "POST",
      path: "/api/v1/intents",
      statusCode: 201,
      durationMs: 12,
      solver: "GABC",
    }),
  );
  run("debug (filtered out)", () => log.debug("hot path detail", { a: 1, b: 2 }));
});
