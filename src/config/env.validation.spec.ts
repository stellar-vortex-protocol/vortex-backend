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
