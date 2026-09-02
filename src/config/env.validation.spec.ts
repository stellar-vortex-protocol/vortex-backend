import { envValidationSchema } from "./env.validation";

const BASE_ENV = {
  NODE_ENV: "development",
};

const VALID_KEY = "S" + "A".repeat(55);

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
      NODE_ENV: "production",
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain("SOROBAN_SIGNING_KEY");
  });

  it("rejects an empty string in production", () => {
    const { error } = envValidationSchema.validate({
      NODE_ENV: "production",
      SOROBAN_SIGNING_KEY: "",
    });
    expect(error).toBeDefined();
  });

  it("accepts a well-formed key in production", () => {
    const { error, value } = envValidationSchema.validate({
      NODE_ENV: "production",
      SOROBAN_SIGNING_KEY: VALID_KEY,
    });
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
