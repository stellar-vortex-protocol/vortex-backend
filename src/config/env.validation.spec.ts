import { envValidationSchema } from "./env.validation";
import { AppConfig, loadConfiguration } from "./configuration";
import {
  REDACTED_CONFIG_FIELDS,
  SECRET_SHAPED_FIELD_PATTERN,
  isSecretShapedField,
  redactConfig,
  REDACTED_PLACEHOLDER,
} from "./config-redaction";

const BASE_ENV = {
  NODE_ENV: "development",
};

const VALID_KEY = "S" + "A".repeat(55);

/**
 * Production requires three secrets/flags that are independent of each other:
 * ONCHAIN_DRY_RUN (#260), SOROBAN_SIGNING_KEY, and KILLSWITCH_OPERATOR_TOKEN
 * (#477). Each test below overrides only the one key it is about, so a failure
 * is attributable to that key rather than to whichever requirement fired first.
 *
 * METRICS_TOKEN (#298) is also required in production.
 */
const PROD_ENV = {
  NODE_ENV: "production",
  ONCHAIN_DRY_RUN: true,
  SOROBAN_SIGNING_KEY: VALID_KEY,
  // Required in production since issue #442 made SEP-10 session signing
  // mandatory — the fixture must carry it for any production validation.
  SEP10_JWT_SIGNING_KEY: VALID_KEY,
  KILLSWITCH_OPERATOR_TOKEN: "operator-secret",
  METRICS_TOKEN: "a-sufficiently-long-metrics-secret",
};

describe("envValidationSchema — SOROBAN_SIGNING_KEY", () => {
  it("defaults to an empty string outside production when unset", () => {
    const { error, value } = envValidationSchema.validate(BASE_ENV);
    expect(error).toBeUndefined();
    expect(value.SOROBAN_SIGNING_KEY).toBe("");
  });

  it("accepts a well-formed Stellar secret seed outside production", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      SOROBAN_SIGNING_KEY: VALID_KEY,
    });
    expect(error).toBeUndefined();
    expect(value.SOROBAN_SIGNING_KEY).toBe(VALID_KEY);
  });

  it("rejects a placeholder value that doesn't match the strkey format", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      SOROBAN_SIGNING_KEY: "changeme",
    });
    expect(error).toBeDefined();
  });

  it("is required in production", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      SOROBAN_SIGNING_KEY: undefined,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("SOROBAN_SIGNING_KEY");
  });

  it("rejects an empty string in production", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      SOROBAN_SIGNING_KEY: "",
    });
    expect(error).toBeDefined();
  });

  it("accepts a well-formed key in production", () => {
    const { error, value } = envValidationSchema.validate(PROD_ENV);
    expect(error).toBeUndefined();
    expect(value.SOROBAN_SIGNING_KEY).toBe(VALID_KEY);
  });
});

describe("envValidationSchema — runtime config flags", () => {
  it("accepts valid boolean, integer, and fee percentile settings", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      ONCHAIN_INTENTS_ENABLED: "true",
      WS_MAX_CONNECTIONS: "250",
      SOROBAN_FEE_PERCENTILE: "p90",
    });

    expect(error).toBeUndefined();
    expect(value.ONCHAIN_INTENTS_ENABLED).toBe(true);
    expect(value.WS_MAX_CONNECTIONS).toBe(250);
    expect(value.SOROBAN_FEE_PERCENTILE).toBe("p90");
  });

  it("rejects non-boolean ONCHAIN_INTENTS_ENABLED values", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      ONCHAIN_INTENTS_ENABLED: "tru",
    });

    expect(error).toBeDefined();
    expect(error?.message).toContain("ONCHAIN_INTENTS_ENABLED");
  });

  it("rejects non-integer WS_MAX_CONNECTIONS values", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      WS_MAX_CONNECTIONS: "not-a-number",
    });

    expect(error).toBeDefined();
    expect(error?.message).toContain("WS_MAX_CONNECTIONS");
  });

  it("rejects unsupported SOROBAN_FEE_PERCENTILE values", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      SOROBAN_FEE_PERCENTILE: "p12",
    });

    expect(error).toBeDefined();
    expect(error?.message).toContain("SOROBAN_FEE_PERCENTILE");
  });
});

describe("envValidationSchema — ONCHAIN_DRY_RUN (#260)", () => {
  it("defaults to true outside production when unset", () => {
    const { error, value } = envValidationSchema.validate(BASE_ENV);
    expect(error).toBeUndefined();
    expect(value.ONCHAIN_DRY_RUN).toBe(true);
  });

  it("accepts true outside production", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      ONCHAIN_DRY_RUN: true,
    });
    expect(error).toBeUndefined();
    expect(value.ONCHAIN_DRY_RUN).toBe(true);
  });

  it("accepts false outside production (explicit opt-out)", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      ONCHAIN_DRY_RUN: false,
    });
    expect(error).toBeUndefined();
    expect(value.ONCHAIN_DRY_RUN).toBe(false);
  });

  it("is required in production — missing value fails validation", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      ONCHAIN_DRY_RUN: undefined,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("ONCHAIN_DRY_RUN");
  });

  it("accepts true in production (keep simulate-only after cutover)", () => {
    const { error, value } = envValidationSchema.validate({
      ...PROD_ENV,
      ONCHAIN_DRY_RUN: true,
    });
    expect(error).toBeUndefined();
    expect(value.ONCHAIN_DRY_RUN).toBe(true);
  });

  it("accepts false in production (live on-chain writes enabled)", () => {
    const { error, value } = envValidationSchema.validate({
      ...PROD_ENV,
      ONCHAIN_DRY_RUN: false,
    });
    expect(error).toBeUndefined();
    expect(value.ONCHAIN_DRY_RUN).toBe(false);
  });
});

describe("envValidationSchema — KILLSWITCH_OPERATOR_TOKEN (issue #477)", () => {
  it("defaults to an empty string outside production, disabling the control plane", () => {
    const { error, value } = envValidationSchema.validate(BASE_ENV);
    expect(error).toBeUndefined();
    expect(value.KILLSWITCH_OPERATOR_TOKEN).toBe("");
  });

  it("accepts an explicitly empty value outside production", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      KILLSWITCH_OPERATOR_TOKEN: "",
    });
    expect(error).toBeUndefined();
  });

  it("is required in production — the control plane must not ship disabled", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      KILLSWITCH_OPERATOR_TOKEN: undefined,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("KILLSWITCH_OPERATOR_TOKEN");
  });

  it("is required in production — an empty value fails validation", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      KILLSWITCH_OPERATOR_TOKEN: "",
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("KILLSWITCH_OPERATOR_TOKEN");
  });

  it("accepts a token in production", () => {
    const { error, value } = envValidationSchema.validate({
      ...PROD_ENV,
      KILLSWITCH_OPERATOR_TOKEN: "a-real-secret",
    });
    expect(error).toBeUndefined();
    expect(value.KILLSWITCH_OPERATOR_TOKEN).toBe("a-real-secret");
  });
});

describe("envValidationSchema — kill-switch propagation (issue #477)", () => {
  it("caps KILLSWITCH_POLL_MS at 5000 so propagation cannot exceed the budget", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      KILLSWITCH_POLL_MS: 10000,
    });
    expect(error).toBeDefined();

    const ok = envValidationSchema.validate({
      ...BASE_ENV,
      KILLSWITCH_POLL_MS: 5000,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.value.KILLSWITCH_POLL_MS).toBe(5000);
  });

  it("defaults KILLSWITCH_POLL_MS to 2000", () => {
    const { error, value } = envValidationSchema.validate(BASE_ENV);
    expect(error).toBeUndefined();
    expect(value.KILLSWITCH_POLL_MS).toBe(2000);
  });

  it("rejects an unknown KILLSWITCH_PERSISTENCE backend", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      KILLSWITCH_PERSISTENCE: "mysql",
    });
    expect(error).toBeDefined();
  });

  it("accepts memory and prisma persistence backends", () => {
    for (const backend of ["memory", "prisma"]) {
      const { error, value } = envValidationSchema.validate({
        ...BASE_ENV,
        KILLSWITCH_PERSISTENCE: backend,
      });
      expect(error).toBeUndefined();
      expect(value.KILLSWITCH_PERSISTENCE).toBe(backend);
    }
  });

  it("treats an empty KILLSWITCH_REDIS_URL as an explicit opt-out of pub/sub", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      KILLSWITCH_REDIS_URL: "",
    });
    expect(error).toBeUndefined();
    expect(value.KILLSWITCH_REDIS_URL).toBe("");
  });
});

describe("config redaction — GET /api/v1/admin/config (#715)", () => {
  const resolvedConfig = loadConfiguration();

  /** Recursively collect dotted paths of every leaf key in an object. */
  const collectKeyPaths = (value: unknown, prefix = ""): string[] => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return prefix ? [prefix] : [];
    }
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return collectKeyPaths(child, path);
      },
    );
  };

  const allKeyPaths = collectKeyPaths(resolvedConfig);

  it("enumerates the resolved AppConfig shape", () => {
    expect(allKeyPaths.length).toBeGreaterThan(0);
    // Sanity-check a few operationally significant fields are present.
    expect(allKeyPaths).toEqual(
      expect.arrayContaining([
        "onchainDryRun",
        "wsMaxConnections",
        "leaderElection.enabled",
        "processRole",
      ]),
    );
  });

  it("denylists every secret-shaped AppConfig field", () => {
    const secretShapedPaths = allKeyPaths.filter((path) => {
      const leaf = path.split(".").pop() as string;
      return SECRET_SHAPED_FIELD_PATTERN.test(leaf);
    });

    // Guard against the regex silently matching nothing.
    expect(secretShapedPaths.length).toBeGreaterThan(0);

    const missing = secretShapedPaths.filter(
      (path) => !REDACTED_CONFIG_FIELDS.includes(path),
    );

    expect(missing).toEqual([]);
  });

  it("redacts every currently-known secret-shaped field", () => {
    const redacted = redactConfig(resolvedConfig) as unknown as Record<
      string,
      unknown
    >;

    for (const path of REDACTED_CONFIG_FIELDS) {
      const segments = path.split(".");
      let cursor: unknown = redacted;
      for (const segment of segments) {
        expect(cursor).toBeDefined();
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      expect(cursor).toBe(REDACTED_PLACEHOLDER);
    }
  });

  it("redacts databaseUrl and secrets.extra", () => {
    const redacted = redactConfig(resolvedConfig) as unknown as {
      databaseUrl: string;
      secrets: { extra: unknown };
    };
    expect(redacted.databaseUrl).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.secrets.extra).toBe(REDACTED_PLACEHOLDER);
  });

  it("leaves non-secret operational fields intact", () => {
    const redacted = redactConfig(resolvedConfig) as unknown as AppConfig;
    expect(redacted.onchainDryRun).toBe(resolvedConfig.onchainDryRun);
    expect(redacted.wsMaxConnections).toBe(resolvedConfig.wsMaxConnections);
    expect(redacted.leaderElection.enabled).toBe(
      resolvedConfig.leaderElection.enabled,
    );
    expect(redacted.processRole).toBe(resolvedConfig.processRole);
  });

  it("fails when a denylist entry is removed", () => {
    const withoutDatabaseUrl = REDACTED_CONFIG_FIELDS.filter(
      (field) => field !== "databaseUrl",
    );
    const redacted = redactConfig(resolvedConfig, {
      fields: withoutDatabaseUrl,
    }) as unknown as { databaseUrl: string };

    // The redaction helper honours the supplied denylist, so dropping an entry
    // leaks the value — exactly what the enumeration test above catches.
    expect(redacted.databaseUrl).not.toBe(REDACTED_PLACEHOLDER);
  });

  it("treats secret-shaped leaf names as secret regardless of nesting", () => {
    expect(isSecretShapedField("apiKey")).toBe(true);
    expect(isSecretShapedField("clientSecret")).toBe(true);
    expect(isSecretShapedField("accessToken")).toBe(true);
    expect(isSecretShapedField("dbPassword")).toBe(true);
    expect(isSecretShapedField("wsMaxConnections")).toBe(false);
    expect(isSecretShapedField("onchainDryRun")).toBe(false);
  });
});

describe("envValidationSchema — METRICS_TOKEN (issue #298)", () => {
  it("defaults to an empty string outside production (endpoint disabled)", () => {
    const { error, value } = envValidationSchema.validate(BASE_ENV);
    expect(error).toBeUndefined();
    expect(value.METRICS_TOKEN).toBe("");
  });

  it("accepts an explicit empty value outside production", () => {
    const { error } = envValidationSchema.validate({
      ...BASE_ENV,
      METRICS_TOKEN: "",
    });
    expect(error).toBeUndefined();
  });

  it("accepts any non-empty token outside production", () => {
    const { error, value } = envValidationSchema.validate({
      ...BASE_ENV,
      METRICS_TOKEN: "short",
    });
    expect(error).toBeUndefined();
    expect(value.METRICS_TOKEN).toBe("short");
  });

  it("is required (non-empty) in production", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      METRICS_TOKEN: undefined,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("METRICS_TOKEN");
  });

  it("rejects an empty string in production", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      METRICS_TOKEN: "",
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("METRICS_TOKEN");
  });

  it("rejects a token shorter than 16 chars in production", () => {
    const { error } = envValidationSchema.validate({
      ...PROD_ENV,
      METRICS_TOKEN: "too-short",
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("METRICS_TOKEN");
  });

  it("accepts a token of at least 16 characters in production", () => {
    const { error, value } = envValidationSchema.validate({
      ...PROD_ENV,
      METRICS_TOKEN: "a-sufficiently-long-metrics-secret",
    });
    expect(error).toBeUndefined();
    expect(value.METRICS_TOKEN).toBe("a-sufficiently-long-metrics-secret");
  });
});
