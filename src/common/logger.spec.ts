/**
 * Tests for issue #94 — LOG_LEVEL should drive the winston log level.
 *
 * resolveLogLevel() is exported from logger.ts and tested in isolation
 * so we don't need to re-import the module with jest.isolateModules().
 */
import { resolveLogLevel } from "./logger";

describe("resolveLogLevel", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    // Restore env after each test
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it("returns LOG_LEVEL when explicitly set, regardless of NODE_ENV", () => {
    process.env.LOG_LEVEL = "warn";
    process.env.NODE_ENV = "production";
    expect(resolveLogLevel()).toBe("warn");
  });

  it("LOG_LEVEL override works in development too", () => {
    process.env.LOG_LEVEL = "error";
    process.env.NODE_ENV = "development";
    expect(resolveLogLevel()).toBe("error");
  });

  it("defaults to 'info' in production when LOG_LEVEL is unset", () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "production";
    expect(resolveLogLevel()).toBe("info");
  });

  it("defaults to 'debug' in development when LOG_LEVEL is unset", () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "development";
    expect(resolveLogLevel()).toBe("debug");
  });

  it("defaults to 'debug' in test environment when LOG_LEVEL is unset", () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "test";
    expect(resolveLogLevel()).toBe("debug");
  });

  it("accepts 'verbose' as a valid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "verbose";
    expect(resolveLogLevel()).toBe("verbose");
  });

  it("accepts 'silly' as a valid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "silly";
    expect(resolveLogLevel()).toBe("silly");
  });
});
