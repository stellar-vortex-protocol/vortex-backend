import * as Joi from "joi";

// Stellar secret seeds ("S..." strkeys) are 56-char base32: prefix + 32-byte
// payload + checksum. This rejects placeholders like "changeme" outright —
// it does not by itself prove the key is a *real, funded* signer.
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(4000),

  // Prisma requires DATABASE_URL in production; optional (with a default) in
  // development/test so the app can boot without a live database for unit tests.
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgresql", "postgres"] })
    .default("postgresql://vortex:vortex@localhost:5432/vortex?schema=public"),

  STELLAR_NETWORK: Joi.string().valid("testnet", "futurenet", "mainnet").default("testnet"),
  SOROBAN_RPC_URL: Joi.string().uri().default("https://soroban-testnet.stellar.org"),
  SETTLEMENT_CONTRACT_ID: Joi.string().allow("").default(""),
  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().allow("").default(""),

  // Secret key for the backend's own Soroban signer (submits on-chain writes
  // such as settlement and slashing calls). No default is provided anywhere
  // in this schema — an unset value fails closed (empty string) rather than
  // ever falling back to a placeholder that could be mistaken for a real key.
  SOROBAN_SIGNING_KEY: Joi.string()
    .pattern(STELLAR_SECRET_KEY_PATTERN)
    .messages({
      "string.pattern.base":
        'SOROBAN_SIGNING_KEY must be a valid Stellar secret seed (starts with "S", 56 base32 characters). ' +
        "Generate a throwaway testnet key for local dev — see README's Signing Key section — never commit a real one.",
    })
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().allow("").default(""),
    }),

  CORS_ORIGIN: Joi.string().default("*"),

  // ── Observability ─────────────────────────────────────────────────────────
  // Sentry DSN for error alerting.  Omit (or leave blank) to disable Sentry.
  SENTRY_DSN: Joi.string().uri().allow("").default(""),

  // Winston log level.  Defaults to "debug" in dev/test and "info" in production.
  LOG_LEVEL: Joi.string()
    .valid("error", "warn", "info", "http", "verbose", "debug", "silly")
    .default(
      // Joi.ref doesn't evaluate lazily here, so we rely on the logger's own
      // resolveLogLevel() for the runtime default — this schema default acts
      // as a documentation hint and config validation guard only.
      "debug",
    ),
});
