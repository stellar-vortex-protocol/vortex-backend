import { of, throwError } from "rxjs";
import { LoggingInterceptor } from "./logging.interceptor";
import { logger } from "./logger";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeContext(method = "GET", originalUrl = "/api/v1/intents", statusCode = 200) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, originalUrl }),
      getResponse: () => ({ statusCode }),
    }),
  } as any;
}

function makeHandler(observable = of({ data: "ok" })) {
  return { handle: () => observable } as any;
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

  it("passes the response through unchanged", (done) => {
    const ctx = makeContext();
    const handler = makeHandler(of({ data: "ok" }));

    interceptor.intercept(ctx, handler).subscribe({
      next: (value) => {
        expect(value).toEqual({ data: "ok" });
        done();
      },
    });
  });

  it("calls logger.info after the handler completes", (done) => {
    const ctx = makeContext("POST", "/api/v1/intents", 201);
    const handler = makeHandler(of({}));

    interceptor.intercept(ctx, handler).subscribe({
      complete: () => {
        expect(logSpy).toHaveBeenCalledTimes(1);
        done();
      },
    });
  });

  it("log message contains method, url, status code, and duration suffix", (done) => {
    const ctx = makeContext("DELETE", "/api/v1/intents/abc", 204);
    const handler = makeHandler(of(null));

    interceptor.intercept(ctx, handler).subscribe({
      complete: () => {
        const msg: string = logSpy.mock.calls[0][0];
        expect(msg).toContain("DELETE");
        expect(msg).toContain("/api/v1/intents/abc");
        expect(msg).toContain("204");
        expect(msg).toMatch(/\d+ms$/);
        done();
      },
    });
  });

  it("log message format is '<METHOD> <URL> <STATUS> <N>ms'", (done) => {
    const ctx = makeContext("GET", "/health", 200);
    const handler = makeHandler(of({}));

    interceptor.intercept(ctx, handler).subscribe({
      complete: () => {
        const msg: string = logSpy.mock.calls[0][0];
        expect(msg).toMatch(/^GET \/health 200 \d+ms$/);
        done();
      },
    });
  });

  it("duration in the log is a non-negative number of milliseconds", (done) => {
    const ctx = makeContext();
    const handler = makeHandler(of({}));

    interceptor.intercept(ctx, handler).subscribe({
      complete: () => {
        const msg: string = logSpy.mock.calls[0][0];
        const match = msg.match(/(\d+)ms$/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThanOrEqual(0);
        done();
      },
    });
  });

  it("does not log when the handler errors — error propagates to subscriber", (done) => {
    const ctx = makeContext();
    const handler = makeHandler(throwError(() => new Error("boom")));

    interceptor.intercept(ctx, handler).subscribe({
      error: (err: Error) => {
        expect(err.message).toBe("boom");
        expect(logSpy).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it("logs once per emission for a stream that emits multiple values", (done) => {
    const ctx = makeContext();
    const handler = makeHandler(of(1, 2, 3));

    interceptor.intercept(ctx, handler).subscribe({
      complete: () => {
        // tap fires for every emission
        expect(logSpy).toHaveBeenCalledTimes(3);
        done();
      },
    });
  });

  it("reads statusCode from the response object at log time, not at intercept time", (done) => {
    // statusCode is mutable; the interceptor must read it inside the tap callback
    const response = { statusCode: 200 };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: "PATCH", originalUrl: "/api/v1/intents/x" }),
        getResponse: () => response,
      }),
    } as any;
    const handler = makeHandler(
      new (require("rxjs").Observable)((subscriber: any) => {
        response.statusCode = 202; // mutate before emission completes
        subscriber.next({});
        subscriber.complete();
      }),
    );

    interceptor.intercept(ctx, handler).subscribe({
      complete: () => {
        const msg: string = logSpy.mock.calls[0][0];
        expect(msg).toContain("202");
        done();
      },
    });
  });
});
