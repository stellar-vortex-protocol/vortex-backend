import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";
import { logger } from "./logger";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeHost(statusFn: jest.Mock, jsonFn: jest.Mock) {
  return {
    switchToHttp: () => ({
      getResponse: () => ({
        status: (code: number) => {
          statusFn(code);
          return { json: jsonFn };
        },
      }),
    }),
  } as any;
}

function buildHost() {
  const jsonFn = jest.fn();
  const statusFn = jest.fn();
  const host = makeHost(statusFn, jsonFn);
  return { host, statusFn, jsonFn };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Branch 1: string body ─────────────────────────────────────────────────

  describe("HttpException with a string body", () => {
    it("wraps the string in { error: <string> }", () => {
      const { host, statusFn, jsonFn } = buildHost();
      const exception = new HttpException("Not found", 404);

      filter.catch(exception, host);

      expect(statusFn).toHaveBeenCalledWith(404);
      expect(jsonFn).toHaveBeenCalledWith({ error: "Not found" });
    });

    it("uses the exception's HTTP status code", () => {
      const { host, statusFn } = buildHost();
      filter.catch(new HttpException("Forbidden", 403), host);
      expect(statusFn).toHaveBeenCalledWith(403);
    });
  });

  // ── Branch 2: validation-array body (class-validator shape) ───────────────

  describe("HttpException with a validation-error body (message is string[])", () => {
    it("responds with { error: 'Validation failed', details: [...] }", () => {
      const { host, statusFn, jsonFn } = buildHost();
      // Simulate the ValidationPipe shape: { message: string[], error, statusCode }
      const exception = new BadRequestException({
        message: ["name must be a string", "email must be an email"],
        error: "Bad Request",
        statusCode: 400,
      });

      filter.catch(exception, host);

      expect(statusFn).toHaveBeenCalledWith(400);
      expect(jsonFn).toHaveBeenCalledWith({
        error: "Validation failed",
        details: ["name must be a string", "email must be an email"],
      });
    });

    it("preserves all validation detail messages in the details array", () => {
      const { host, _, jsonFn } = buildHost() as any;
      const messages = ["field1 error", "field2 error", "field3 error"];
      const exception = new BadRequestException({ message: messages, error: "Bad Request", statusCode: 400 });

      filter.catch(exception, host);

      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ details: messages }),
      );
    });
  });

  // ── Branch 3: custom-shaped body (error is string, message is not string) ─

  describe("HttpException with a custom-shaped body", () => {
    it("passes the body through as-is when it has an error string and no message string", () => {
      const { host, statusFn, jsonFn } = buildHost();
      const customBody = {
        error: "Insufficient liquidity",
        fillAmount: "1000000",
        minDstAmount: "990000",
      };
      const exception = new BadRequestException(customBody);

      filter.catch(exception, host);

      expect(statusFn).toHaveBeenCalledWith(400);
      // The body passed through should contain the custom fields
      const call = jsonFn.mock.calls[0][0] as Record<string, unknown>;
      expect(call.error).toBe("Insufficient liquidity");
      expect(call.fillAmount).toBe("1000000");
      expect(call.minDstAmount).toBe("990000");
    });
  });

  // ── Branch 4: object body with a string `message` ─────────────────────────

  describe("HttpException whose body has a string message", () => {
    it("responds with { error: <message string> }", () => {
      const { host, statusFn, jsonFn } = buildHost();
      // NestJS HttpException defaults produce { message, statusCode } when called
      // via built-in exceptions like NotFoundException
      const exception = new NotFoundException("Intent not found");

      filter.catch(exception, host);

      expect(statusFn).toHaveBeenCalledWith(404);
      expect(jsonFn).toHaveBeenCalledWith({ error: "Intent not found" });
    });
  });

  // ── Branch 5: fallback — non-HttpException Error ───────────────────────────

  describe("non-HttpException Error", () => {
    it("responds with 500 and { error: <message> }", () => {
      const { host, statusFn, jsonFn } = buildHost();
      const err = new Error("database connection lost");

      filter.catch(err, host);

      expect(statusFn).toHaveBeenCalledWith(500);
      expect(jsonFn).toHaveBeenCalledWith({ error: "database connection lost" });
    });

    it("logs the error stack via logger.error", () => {
      const { host } = buildHost();
      const err = new Error("oops");

      filter.catch(err, host);

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("handles a thrown non-Error value and returns a generic message", () => {
      const { host, statusFn, jsonFn } = buildHost();

      filter.catch("some string thrown", host);

      expect(statusFn).toHaveBeenCalledWith(500);
      // Non-Error values produce "Unknown error" as message
      expect(jsonFn).toHaveBeenCalledWith({ error: "Internal server error" });
    });

    it("handles a thrown null value gracefully", () => {
      const { host, statusFn } = buildHost();

      expect(() => filter.catch(null, host)).not.toThrow();
      expect(statusFn).toHaveBeenCalledWith(500);
    });
  });
});
