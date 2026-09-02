/**
 * Tests for the log-shipping transport added alongside the shared logger.
 *
 * We re-import the module fresh per test (isolateModules) since the
 * transport is built once at module load time from env vars.
 */
describe("log shipping transport", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  function loadLogger() {
    let mod: typeof import("./logger");
    jest.isolateModules(() => {
      mod = require("./logger");
    });
    return mod!;
  }

  it("does not register a shipping transport when LOG_SHIPPING_ENABLED is unset", () => {
    delete process.env.LOG_SHIPPING_ENABLED;
    const { logger } = loadLogger();
    expect(logger.transports).toHaveLength(1);
  });

  it("does not register a shipping transport when host/port are missing even if enabled", () => {
    process.env.LOG_SHIPPING_ENABLED = "true";
    delete process.env.LOG_SHIPPING_HOST;
    delete process.env.LOG_SHIPPING_PORT;
    const { logger } = loadLogger();
    expect(logger.transports).toHaveLength(1);
  });

  it("registers a second transport when LOG_SHIPPING_ENABLED is true with host/port set", () => {
    process.env.LOG_SHIPPING_ENABLED = "true";
    process.env.LOG_SHIPPING_HOST = "logs.example.com";
    process.env.LOG_SHIPPING_PORT = "443";
    const { logger } = loadLogger();
    expect(logger.transports).toHaveLength(2);
  });

  it("redacts sensitive fields before they reach a shipped log entry", () => {
    process.env.LOG_SHIPPING_ENABLED = "true";
    process.env.LOG_SHIPPING_HOST = "logs.example.com";
    process.env.LOG_SHIPPING_PORT = "443";
    const { logger } = loadLogger();

    const shippingTransport = logger.transports[1];
    const formatted = shippingTransport.format!.transform(
      {
        level: "info",
        message: "signed request",
        signingKey: "SABCDEF_SUPER_SECRET",
        password: "hunter2",
        token: "abc.def.ghi",
      } as any,
      {},
    ) as Record<string, unknown>;

    expect(formatted.signingKey).toBe("[REDACTED]");
    expect(formatted.password).toBe("[REDACTED]");
    expect(formatted.token).toBe("[REDACTED]");
    expect(JSON.stringify(formatted)).not.toContain("SABCDEF_SUPER_SECRET");
    expect(JSON.stringify(formatted)).not.toContain("hunter2");
  });
});
