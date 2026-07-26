import * as Joi from "joi";

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(4000),

  STELLAR_NETWORK: Joi.string().valid("testnet", "futurenet", "mainnet").default("testnet"),
  SOROBAN_RPC_URL: Joi.string().uri().default("https://soroban-testnet.stellar.org"),
  SETTLEMENT_CONTRACT_ID: Joi.string().allow("").default(""),
  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().allow("").default(""),

  // Backend hot-wallet secret used to sign settlement transactions. Required in
  // production so the app fails fast on boot rather than at first-submit; optional
  // elsewhere so `npm run dev`/tests don't need a real key. Never logged.
  SOROBAN_SIGNER_SECRET_KEY: Joi.string()
    .pattern(/^S[A-Z2-7]{55}$/)
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().allow("").default(""),
    }),

  // Rollout flag: when false (default), IntentsService.create() stays fully
  // in-memory as before. Flip on once the settlement contract + signer are
  // ready in a given environment; flip back off to fall back instantly if
  // on-chain registration misbehaves.
  ONCHAIN_INTENTS_ENABLED: Joi.boolean().default(false),

  CORS_ORIGIN: Joi.string().default("*"),
});
