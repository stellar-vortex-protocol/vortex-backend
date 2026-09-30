import { Observable, of, throwError } from "rxjs";
import { LoggingInterceptor } from "./logging.interceptor";
import { logger } from "./logger";

// ─── helpers ────────────────────────────────────────────────────────────────

interface FakeRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

function makeContext(
  method = "GET",
  originalUrl = "/api/v1/intents",
  statusCode = 200,
  headers: Record<string, string | string[] | undefined> = {},
  request: FakeRequest = { method, originalUrl, headers },
) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode }),
    }),
  } as any;
}

function makeHandler(observable: Observable<unknown> = of({ data: "ok" })) {
  return { handle: () => observable } as any;
}

/**
 * `of()` and `throwError()` are synchronous, so subscribing already runs the
 * `tap` side effects before this returns. Asserting afterwards (rather than
 * inside a `done` callback) means a failure surfaces as the real expectation
 * mismatch instead of a 5s timeout.
 */
function intercept(
  interceptor: LoggingInterceptor,
  ctx: unknown,
  handler: unknown,
): { emitted: unknown[]; error?: unknown } {
  const emitted: unknown[] = [];
  let error: unknown;
  let hasError = false;

  (interceptor.intercept(ctx as any, handler as any) as Observable<unknown>).subscribe({
    next: (value) => emitted.push(value),
    error: (err) => {
      error = err;
      hasError = true;
    },
  });

  return hasError ? { emitted, error } : { emitted };
}

/**
 * Each emission writes two `logger.info` calls: a correlated line carrying the
 * request id, and a sanitized line shaped `<METHOD> <URL> <STATUS> <N>ms`.
 */
function correlatedLine(spy: jest.SpyInstance, emission = 0): string {
  return spy.mock.calls[emission * 2][0] as string;
}

function accessLine(spy: jest.SpyInstance, emission = 0): string {
  return spy.mock.calls[emission * 2 + 1][0] as string;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("LoggingInterceptor", () => {
  let interceptor: LoggingInterceptor;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    logSpy = jest.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the response through unchanged", () => {
    const result = intercept(interceptor, makeContext(), makeHandler(of({ data: "ok" })));

    expect(result.emitted).toEqual([{ data: "ok" }]);
    expect(result.error).toBeUndefined();
  });

  it("calls logger.info after the handler completes", () => {
    intercept(interceptor, makeContext("POST", "/api/v1/intents", 201), makeHandler(of({})));

    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("log message contains method, url, status code, and duration suffix", () => {
    intercept(interceptor, makeContext("DELETE", "/api/v1/intents/abc", 204), makeHandler(of(null)));

    const msg = accessLine(logSpy);
    expect(msg).toContain("DELETE");
    expect(msg).toContain("/api/v1/intents/abc");
    expect(msg).toContain("204");
    expect(msg).toMatch(/\d+ms$/);
  });

  it("log message format is '<METHOD> <URL> <STATUS> <N>ms'", () => {
    intercept(interceptor, makeContext("GET", "/health", 200), makeHandler(of({})));

    expect(accessLine(logSpy)).toMatch(/^GET \/health 200 \d+ms$/);
  });

  it("duration in the log is a non-negative number of milliseconds", () => {
    intercept(interceptor, makeContext(), makeHandler(of({})));

    const match = accessLine(logSpy).match(/(\d+)ms$/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0);
  });

  it("does not log when the handler errors — error propagates to subscriber", () => {
    const result = intercept(
      interceptor,
      makeContext(),
      makeHandler(throwError(() => new Error("boom"))),
    );

    expect((result.error as Error).message).toBe("boom");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs once per emission for a stream that emits multiple values", () => {
    const result = intercept(interceptor, makeContext(), makeHandler(of(1, 2, 3)));

    expect(result.emitted).toEqual([1, 2, 3]);
    // tap fires for every emission, and each emission writes two lines.
    expect(logSpy).toHaveBeenCalledTimes(6);
  });

  it("reads statusCode from the response object at log time, not at intercept time", () => {
    // statusCode is mutable; the interceptor must read it inside the tap callback
    const response = { statusCode: 200 };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: "PATCH", originalUrl: "/api/v1/intents/x", headers: {} }),
        getResponse: () => response,
      }),
    } as any;
    const handler = makeHandler(
      new Observable((subscriber) => {
        response.statusCode = 202; // mutate before emission completes
        subscriber.next({});
        subscriber.complete();
      }),
    );

    intercept(interceptor, ctx, handler);

    expect(accessLine(logSpy)).toContain("202");
  });

  // ── request correlation ───────────────────────────────────────────────────

  describe("requestId", () => {
    it("generates a uuid requestId when the header is absent", () => {
      const request: FakeRequest = { method: "GET", originalUrl: "/x", headers: {} };

      intercept(interceptor, makeContext("GET", "/x", 200, {}, request), makeHandler(of({})));

      const requestId = request.requestId!;
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(correlatedLine(logSpy)).toMatch(
        new RegExp(`^\\[${requestId}\\] GET /x 200 \\d+ms$`),
      );
    });

    it("adopts an inbound x-request-id header", () => {
      const request: FakeRequest = {
        method: "GET",
        originalUrl: "/x",
        headers: { "x-request-id": "req-abc-123" },
      };

      intercept(interceptor, makeContext("GET", "/x", 200, request.headers, request), makeHandler(of({})));

      expect(request.requestId).toBe("req-abc-123");
      expect(correlatedLine(logSpy)).toContain("[req-abc-123]");
    });

    it("takes the first value when x-request-id is an array", () => {
      const request: FakeRequest = {
        method: "GET",
        originalUrl: "/x",
        headers: { "x-request-id": ["first", "second"] },
      };

      intercept(interceptor, makeContext("GET", "/x", 200, request.headers, request), makeHandler(of({})));

      expect(request.requestId).toBe("first");
    });
  });

  // ── log-injection defence ────────────────────────────────────────────────

  describe("URL sanitization", () => {
    it("strips newlines so a crafted path cannot forge extra log lines", () => {
      intercept(
        interceptor,
        makeContext("GET", "/api/v1/intents\nFAKE 200 0ms", 200),
        makeHandler(of({})),
      );

      // The newline becomes a space, so the forged text is neutralised into
      // ordinary content on this one line — it cannot become a second entry.
      const line = accessLine(logSpy);
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\r");
      expect(line).toMatch(/^GET \/api\/v1\/intents FAKE 200 0ms 200 \d+ms$/);
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(correlatedLine(logSpy)).not.toContain("\n");
    });

    it("strips carriage returns and other control characters", () => {
      intercept(interceptor, makeContext("GET", "/a\rb /c", 200), makeHandler(of({})));

      const line = accessLine(logSpy);
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(line).toMatch(/^GET \/a b \/c 200 \d+ms$/);
    });
  });
});
