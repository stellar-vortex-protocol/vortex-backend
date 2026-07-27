import * as Joi from "joi";

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(4000),

  STELLAR_NETWORK: Joi.string().valid("testnet", "futurenet", "mainnet").default("testnet"),
  SOROBAN_RPC_URL: Joi.string().uri().default("https://soroban-testnet.stellar.org"),
  SETTLEMENT_CONTRACT_ID: Joi.string().allow("").default(""),
  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().allow("").default(""),

  /**
   * Allowed CORS origin(s) — comma-separated list of explicit origins or "*".
   *
   * In production the wildcard "*" is rejected so that deployments cannot
   * accidentally serve credentialed-adjacent requests from any origin.
   * Set this to the frontend's production URL, e.g.:
   *   CORS_ORIGIN=https://app.vortex.trade
   *
   * In development/test the value defaults to "*" for convenience.
   */
  CORS_ORIGIN: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string()
      .invalid("*")
      .required()
      .messages({
        "any.invalid":
          'CORS_ORIGIN must be set to an explicit origin (not "*") when NODE_ENV=production',
        "any.required":
          'CORS_ORIGIN is required when NODE_ENV=production — set it to the frontend origin (e.g. https://app.vortex.trade)',
      }),
    otherwise: Joi.string().default("*"),
  }),

  /**
   * Maximum number of simultaneous WebSocket connections the gateway will
   * accept before rejecting new ones with close code 1013 (try again later).
   * Defaults to 1000.  Set to 0 to disable the cap (not recommended in prod).
   */
  WS_MAX_CONNECTIONS: Joi.number().integer().min(0).default(1000),
});
