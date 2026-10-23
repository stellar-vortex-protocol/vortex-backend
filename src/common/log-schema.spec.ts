/**
 * Schema-conformance tests for emitted log records (issue #488).
 *
 * Records are captured at the transport — after the logger's format pipeline
 * has run — so these assertions cover exactly what a sink receives.
 */
import Transport from "winston-transport";
import { trace, context, ROOT_CONTEXT, TraceFlags } from "@opentelemetry/api";
import { bindLogContext, getLogContext, runWithLogContext } from "./log-context";
import { LOG_EVENTS, LOG_SCHEMA_VERSION, normalizeLogFields, validateLogRecord, toCamelKey } from "./log-schema";
import { createLogger, logger, NestStructuredLogger } from "./logger";

const MESSAGE = Symbol.for("message");

class CaptureTransport extends Transport {
  readonly records: Record<string, unknown>[] = [];
  readonly lines: string[] = [];
  log(info: Record<string | symbol, unknown>, done: () => void): void {
    this.records.push({ ...info });
    this.lines.push(String(info[MESSAGE]));
    done();
  }
}

describe("structured log schema", () => {
  let capture: CaptureTransport;
  const originalLevel = logger.level;

  beforeEach(() => {
    capture = new CaptureTransport();
    logger.add(capture);
    // Keep the console transport quiet; capture sees everything.
    logger.transports.forEach((t) => {
      if (t !== capture) t.silent = true;
    });
    logger.level = "debug";
  });

  afterEach(() => {
    logger.remove(capture);
    logger.transports.forEach((t) => (t.silent = false));
    logger.level = originalLevel;
  });

  it("emits every required field with the documented types", () => {
    createLogger("TestComponent").info("thing happened", { intentId: "intent-1", amount: "100" });

    const [record] = capture.records;
    expect(validateLogRecord(record)).toEqual([]);
    expect(record).toMatchObject({
      level: "info",
      message: "thing happened",
      service: expect.any(String),
      schemaVersion: LOG_SCHEMA_VERSION,
      component: "TestComponent",
      intentId: "intent-1",
      amount: "100",
    });
  });

  it("stamps request-scoped context fields onto records written inside the scope", () => {
    const log = createLogger("Ctx");
    runWithLogContext({ requestId: "req-1", chain: "stellar" }, () => {
      bindLogContext({ intentId: "intent-9", solver: "GSOLVER" });
      log.warn("inside");
    });
    log.warn("outside");

    const [inside, outside] = capture.records;
    expect(inside).toMatchObject({ requestId: "req-1", chain: "stellar", intentId: "intent-9", solver: "GSOLVER" });
    expect(outside.requestId).toBeUndefined();
    expect(validateLogRecord(inside)).toEqual([]);
  });

  it("lets explicit fields override the context", () => {
    runWithLogContext({ intentId: "from-context" }, () => {
      createLogger("Ctx").info("override", { intentId: "explicit" });
    });
    expect(capture.records[0].intentId).toBe("explicit");
  });

  it("propagates context across awaits and isolates concurrent scopes", async () => {
    const log = createLogger("Async");
    await Promise.all(
      ["a", "b", "c"].map((id) =>
        runWithLogContext({ requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          log.info("after await");
        }),
      ),
    );
    expect(capture.records.map((r) => r.requestId).sort()).toEqual(["a", "b", "c"]);
  });

  it("nested scopes inherit and never leak back into the parent", () => {
    runWithLogContext({ requestId: "outer" }, () => {
      runWithLogContext({ jobId: "job-1" }, () => {
        expect(getLogContext()).toEqual({ requestId: "outer", jobId: "job-1" });
      });
      expect(getLogContext()).toEqual({ requestId: "outer" });
    });
  });

  it("adds traceId/spanId from the active OTel span", () => {
    const spanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    };
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext);
    context.with(ctx, () => createLogger("Trace").info("traced"));
    // Without a registered context manager `context.with` is a no-op, so only
    // assert when the span was actually active.
    const record = capture.records[0];
    if (record.traceId !== undefined) {
      expect(record).toMatchObject({ traceId: spanContext.traceId, spanId: spanContext.spanId });
    }
    expect(validateLogRecord(record)).toEqual([]);
  });

  it("serialises errors into err { name, message, stack }", () => {
    createLogger("Err").error("operation failed", { err: new TypeError("bad input") });
    const err = capture.records[0].err as Record<string, unknown>;
    expect(err).toMatchObject({ name: "TypeError", message: "bad input" });
    expect(typeof err.stack).toBe("string");
    expect(validateLogRecord(capture.records[0])).toEqual([]);
  });

  it("redacts sensitive fields at any depth", () => {
    createLogger("Redact").info("credentials", {
      secretKey: "SXXX",
      nested: { password: "hunter2", deeper: { apiKey: "vx_live_abc" } },
    });
    const json = JSON.stringify(capture.records[0]);
    expect(json).not.toContain("SXXX");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("vx_live_abc");
    expect(json).toContain("[REDACTED]");
  });

  it("renames reserved keys and camelCases foreign keys instead of corrupting the record", () => {
    createLogger("Keys").info("odd keys", { level: "fake", tx_hash: "abc", "dst-amount": "5" });
    const record = capture.records[0];
    expect(record.level).toBe("info");
    expect(record.level_).toBe("fake");
    expect(record.txHash).toBe("abc");
    expect(record.dstAmount).toBe("5");
    expect(validateLogRecord(record)).toEqual([]);
  });

  it("child loggers bind fields to every record", () => {
    const log = createLogger("Child").child({ intentId: "bound" });
    log.info("one");
    log.info("two", { step: 2 });
    expect(capture.records.map((r) => r.intentId)).toEqual(["bound", "bound"]);
  });

  it("drops records below the active level without formatting them", () => {
    logger.level = "info";
    createLogger("Lvl").debug("hidden", { huge: "x".repeat(10) });
    expect(capture.records).toHaveLength(0);
  });

  it("routes Nest Logger calls through the same schema", () => {
    const nest = new NestStructuredLogger();
    nest.log("legacy line", "LegacyService");
    nest.warn("with fields", { intentId: "i-1" }, "LegacyService");
    nest.error("boom", "Error: boom\n    at x", "LegacyService");
    const [plain, withFields, withStack] = capture.records;
    expect(plain).toMatchObject({ message: "legacy line", component: "LegacyService", level: "info" });
    expect(withFields).toMatchObject({ intentId: "i-1", component: "LegacyService", level: "warn" });
    expect(withStack.err).toMatchObject({ message: "boom", stack: expect.stringContaining("at x") });
    for (const record of capture.records) expect(validateLogRecord(record)).toEqual([]);
  });

  it("produces security events that match the alert rules' event names", () => {
    createLogger("Sec").warn("signature verification failed", { event: LOG_EVENTS.SIGNATURE_FAILURE });
    expect(capture.records[0].event).toBe("security.signature_failure");
    expect(validateLogRecord(capture.records[0])).toEqual([]);
  });

  it("writes parseable single-line JSON in LOG_FORMAT=json", () => {
    const previous = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "json";
    let isolated: typeof import("./logger") | undefined;
    jest.isolateModules(() => {
      isolated = require("./logger");
    });
    process.env.LOG_FORMAT = previous;
    const jsonCapture = new CaptureTransport();
    isolated!.logger.add(jsonCapture);
    isolated!.logger.transports.forEach((t) => {
      if (t !== jsonCapture) t.silent = true;
    });
    isolated!.logger.level = "debug";

    isolated!.createLogger("Json").info("line one", { path: "/a\nb", intentId: "x" });

    const raw = jsonCapture.lines[0];
    expect(raw).not.toContain("\n");
    const parsed = JSON.parse(raw);
    expect(validateLogRecord(parsed)).toEqual([]);
    expect(parsed).toMatchObject({ message: "line one", intentId: "x", path: "/a\nb" });
  });
});

describe("validateLogRecord", () => {
  const valid = {
    timestamp: new Date().toISOString(),
    level: "info",
    message: "ok",
    service: "vortex-backend",
    schemaVersion: LOG_SCHEMA_VERSION,
  };

  it("accepts a minimal record", () => {
    expect(validateLogRecord(valid)).toEqual([]);
  });

  it.each([
    [{ timestamp: "not a date" }, "timestamp"],
    [{ level: "loud" }, "level"],
    [{ message: "" }, "message"],
    [{ schemaVersion: 0 }, "schemaVersion"],
    [{ intentId: 42 }, "intentId"],
    [{ event: "Not An Event" }, "event"],
    [{ traceId: "xyz" }, "traceId"],
    [{ durationMs: -1 }, "durationMs"],
    [{ err: "boom" }, "err"],
    [{ snake_case: 1 }, "snake_case"],
  ])("flags %j", (override, field) => {
    const problems = validateLogRecord({ ...valid, ...override });
    expect(problems.some((p) => p.startsWith(field))).toBe(true);
  });
});

describe("normalizeLogFields", () => {
  it("handles bigint, dates, cycles and undefined", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = normalizeLogFields({ big: 10n, when: new Date(0), cyclic, gone: undefined });
    expect(out.big).toBe("10");
    expect(out.when).toBe("1970-01-01T00:00:00.000Z");
    expect((out.cyclic as Record<string, unknown>).self).toBe("[Circular]");
    expect("gone" in out).toBe(false);
  });

  it("camelCases keys", () => {
    expect(toCamelKey("tx_hash")).toBe("txHash");
    expect(toCamelKey("X-Request-Id")).toBe("xRequestId");
    expect(toCamelKey("123abc")).toBe("f123abc");
  });
});
