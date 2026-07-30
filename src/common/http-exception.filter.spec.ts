import { HttpException, HttpStatus, ArgumentsHost } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";
import * as sentryModule from "./sentry";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeHost(json: jest.Mock): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({
        status: (_code: number) => ({ json }),
      }),
    }),
  } as unknown as ArgumentsHost;
}

// ── Sentry mock ───────────────────────────────────────────────────────────────
// Spy on captureException so we can assert it is called only in the 500 branch.

jest.mock("./sentry", () => ({
  initSentry: jest.fn(),
  captureException: jest.fn(),
}));

// ── tests ─────────────────────────────────────────────────────────────────────

describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;
  let json: jest.Mock;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    json = jest.fn();
    jest.clearAllMocks();
  });

  describe("HttpException branch", () => {
    it("returns the correct status for a 404", () => {
      const host = makeHost(json);
      filter.catch(new HttpException("Not found", HttpStatus.NOT_FOUND), host);
      expect(json).toHaveBeenCalledWith({ error: "Not found" });
    });

    it("does NOT call captureException for expected HttpExceptions (no alert fatigue)", () => {
      const host = makeHost(json);
      filter.catch(new HttpException("Bad request", HttpStatus.BAD_REQUEST), host);
      expect(sentryModule.captureException).not.toHaveBeenCalled();
    });

    it("surfaces class-validator array messages", () => {
      const host = makeHost(json);
      const body = { message: ["field must not be empty"], error: "Bad Request", statusCode: 400 };
      filter.catch(new HttpException(body, HttpStatus.BAD_REQUEST), host);
      expect(json).toHaveBeenCalledWith({
        error: "Validation failed",
        details: ["field must not be empty"],
      });
    });
  });

  describe("generic Error branch (500)", () => {
    it("returns 500 json for an unhandled Error", () => {
      const host = makeHost(json);
      filter.catch(new Error("boom"), host);
      expect(json).toHaveBeenCalledWith({ error: "boom" });
    });

    it("calls captureException with the Error instance (Sentry alerting)", () => {
      const host = makeHost(json);
      const err = new Error("unexpected failure");
      filter.catch(err, host);
      expect(sentryModule.captureException).toHaveBeenCalledTimes(1);
      expect(sentryModule.captureException).toHaveBeenCalledWith(err);
    });

    it("wraps non-Error throws and still calls captureException", () => {
      const host = makeHost(json);
      filter.catch("string throw", host);
      expect(sentryModule.captureException).toHaveBeenCalledTimes(1);
      const captured = (sentryModule.captureException as jest.Mock).mock.calls[0][0];
      expect(captured).toBeInstanceOf(Error);
    });

    it("returns 500 with fallback message for unknown throws", () => {
      const host = makeHost(json);
      filter.catch(null, host);
      expect(json).toHaveBeenCalledWith({ error: "Unknown error" });
    });
  });
});
