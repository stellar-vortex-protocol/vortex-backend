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
 * Each emission writes one structured `http.request` record. `logger.log` is
 * winston's `(level, message, meta)` entry point, which the structured
 * logger funnels every record through.
 */
interface RecordedLine {
  level: string;
  message: string;
  meta: Record<string, unknown>;
}

function line(spy: jest.SpyInstance, emission = 0): RecordedLine {
  const [level, message, meta] = spy.mock.calls[emission];
  return { level, message, meta };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("LoggingInterceptor", () => {
  let interceptor: LoggingInterceptor;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    logSpy = jest.spyOn(logger, "log").mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the response through unchanged", () => {
    const result = intercept(interceptor, makeContext(), makeHandler(of({ data: "ok" })));

    expect(result.emitted).toEqual([{ data: "ok" }]);
    expect(result.error).toBeUndefined();
  });

  it("writes one info record after the handler completes", () => {
    intercept(interceptor, makeContext("POST", "/api/v1/intents", 201), makeHandler(of({})));

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(line(logSpy).level).toBe("info");
  });

  it("uses a constant message and puts request details in structured fields", () => {
    intercept(interceptor, makeContext("DELETE", "/api/v1/intents/abc", 204), makeHandler(of(null)));

    const { message, meta } = line(logSpy);
    expect(message).toBe("http request completed");
    expect(meta).toMatchObject({
      component: "http",
      event: "http.request",
      method: "DELETE",
      path: "/api/v1/intents/abc",
      statusCode: 204,
    });
  });

  it("records a non-negative integer durationMs", () => {
    intercept(interceptor, makeContext(), makeHandler(of({})));

    const { durationMs } = line(logSpy).meta;
    expect(typeof durationMs).toBe("number");
    expect(durationMs as number).toBeGreaterThanOrEqual(0);
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
    expect(logSpy).toHaveBeenCalledTimes(3);
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

    expect(line(logSpy).meta.statusCode).toBe(202);
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
      expect(line(logSpy).meta.requestId).toBe(requestId);
    });

    it("adopts an inbound x-request-id header", () => {
      const request: FakeRequest = {
        method: "GET",
        originalUrl: "/x",
        headers: { "x-request-id": "req-abc-123" },
      };

      intercept(interceptor, makeContext("GET", "/x", 200, request.headers, request), makeHandler(of({})));

      expect(request.requestId).toBe("req-abc-123");
      expect(line(logSpy).meta.requestId).toBe("req-abc-123");
    });

    it("uses the first value when x-request-id is sent more than once", () => {
      const request: FakeRequest = {
        method: "GET",
        originalUrl: "/x",
        headers: { "x-request-id": ["first", "second"] },
      };

      intercept(interceptor, makeContext("GET", "/x", 200, request.headers, request), makeHandler(of({})));

      expect(request.requestId).toBe("first");
    });

    it("keeps a requestId already assigned by the request-context middleware", () => {
      const request: FakeRequest = {
        method: "GET",
        originalUrl: "/x",
        headers: { "x-request-id": "from-header" },
        requestId: "from-middleware",
      };

      intercept(interceptor, makeContext("GET", "/x", 200, request.headers, request), makeHandler(of({})));

      expect(line(logSpy).meta.requestId).toBe("from-middleware");
    });

    it("replaces an x-request-id that is unsafe to log", () => {
      const request: FakeRequest = {
        method: "GET",
        originalUrl: "/x",
        headers: { "x-request-id": "evil\nFAKE line" },
      };

      intercept(interceptor, makeContext("GET", "/x", 200, request.headers, request), makeHandler(of({})));

      expect(request.requestId).not.toContain("\n");
      expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
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

      const path = line(logSpy).meta.path as string;
      expect(path).not.toContain("\n");
      expect(path).not.toContain("\r");
      expect(path).toBe("/api/v1/intents FAKE 200 0ms");
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("strips carriage returns and other control characters", () => {
      intercept(interceptor, makeContext("GET", "/a\rb /c", 200), makeHandler(of({})));

      const path = line(logSpy).meta.path as string;
      // eslint-disable-next-line no-control-regex
      expect(path).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(path).toBe("/a b /c");
    });
  });
});
