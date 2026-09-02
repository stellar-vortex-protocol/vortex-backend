/**
 * AUTO-GENERATED — do not edit by hand.
 * Regenerate with: npm run generate:client
 *
 * Usage (with openapi-fetch):
 *   import createClient from 'openapi-fetch';
 *   import type { paths } from './generated/api-types';
 *   const client = createClient<paths>({ baseUrl: 'http://localhost:4000' });
 *
 * Closes #134
 */

// prettier-ignore
export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["HealthController_check"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/chain/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SorobanController_getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/chain/ledger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SorobanController_getLatestLedger"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/chain/network": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SorobanController_getNetwork"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/chain/account/{publicKey}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SorobanController_getAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["TokensController_getTokens"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tokens/stellar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["TokensController_getStellarTokens"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["IntentsController_list"];
        put?: never;
        post: operations["IntentsController_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/open": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["IntentsController_listOpen"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/user/{address}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["IntentsController_listByUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["IntentsController_getOne"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/{id}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get audit trail for an intent
         * @description Returns the full state-transition history for an intent ordered oldest-first. Each entry records the state the intent moved into, who triggered it, and why.
         */
        get: operations["IntentsController_getAudit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/{id}/quote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["IntentsController_getPersistedQuote"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/{id}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["IntentsController_accept"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/{id}/fill": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["IntentsController_fill"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["IntentsController_cancel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/intents/quote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["IntentsController_quote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/solvers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SolversController_getLeaderboard"];
        put?: never;
        post: operations["SolversController_register"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/solvers/{address}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SolversController_getSolver"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["SolversController_updateSolver"];
        trace?: never;
    };
    "/api/v1/solvers/{address}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SolversController_getSolverStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/solvers/{address}/deregister": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["SolversController_deregisterSolver"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/solvers/{address}/deactivate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["SolversController_deactivate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/solvers/{address}/reactivate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["SolversController_reactivate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["StatsController_getStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/stats/ws": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["StatsController_getWsStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        StellarTokenDto: {
            /** @description Stellar contract ID of the token */
            contract: string;
            /** @example XLM */
            symbol: string;
            /** @example Stellar Lumens */
            name: string;
            /** @example 7 */
            decimals: number;
            /** @example 0.1182 */
            priceUSD: number;
        };
        StellarTokensResponseDto: {
            tokens: components["schemas"]["StellarTokenDto"][];
        };
        CreateIntentDto: {
            /** @description Stellar address of the user creating the intent */
            user: string;
            /**
             * @description Source chain the funds are coming from
             * @enum {string}
             */
            srcChain: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
            /** @description Source token contract/address on srcChain */
            srcTokenAddress: string;
            /** @description Source token symbol, e.g. USDC */
            srcTokenSymbol: string;
            /** @description Source token decimals */
            srcTokenDecimals: number;
            /** @description Source amount as a non-negative integer string (base units) */
            srcAmount: string;
            /** @description Destination Stellar token contract */
            dstTokenContract: string;
            /** @description Destination token symbol, e.g. USDC */
            dstTokenSymbol: string;
            /** @description Destination token decimals */
            dstTokenDecimals: number;
            /** @description Minimum acceptable destination amount as an integer string */
            minDstAmount: string;
            /** @description Unix timestamp deadline; defaults to now + 1800s; must be between now+60s and now+24h */
            deadline?: number;
            /** @description Idempotency key for deduplicating duplicate requests */
            idempotencyKey?: string;
        };
        AcceptIntentDto: {
            /** @description Solver address accepting the intent */
            solver: string;
            /** @description Base64-encoded Ed25519 signature of the message "accept:<intentId>:<solver>" produced by the solver's private key */
            signature: string;
        };
        FillIntentDto: {
            /** @description Solver address filling the intent (must match the accepting solver) */
            solver: string;
            /** @description Amount filled, as a non-negative integer string */
            fillAmount: string;
            /** @description Stellar fill transaction hash */
            txHash?: string;
            /** @description Base64-encoded Ed25519 signature of the message "fill:<intentId>:<solver>" produced by the solver's private key */
            signature: string;
        };
        CancelIntentDto: {
            /** @description Stellar address of the intent's original creator (must match) */
            user: string;
            /** @description Base64-encoded Ed25519 signature of the message "cancel:<intentId>" produced by the private key of `user` */
            signature: string;
        };
        QuoteRequestDto: {
            /**
             * @description Source chain the funds are coming from
             * @enum {string}
             */
            srcChain: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
            /** @description Source token symbol, e.g. USDC */
            srcTokenSymbol: string;
            /** @description Source amount as a non-negative integer string */
            srcAmount: string;
            /** @description Destination token symbol, e.g. USDC */
            dstTokenSymbol: string;
            /** @description Intent ID to persist the quote to */
            intentId?: string;
            /** @description Source token contract address / ID (used for precise token resolution) */
            srcTokenAddress?: string;
            /** @description Destination Stellar token contract ID (used for precise token resolution) */
            dstTokenContract?: string;
        };
        RouteStepDto: {
            /** @enum {string} */
            type: "bridge" | "swap" | "transfer";
            /** @description Protocol name, e.g. 'direct-solver', 'uniswap-v3' */
            protocol: string;
            fromChain: string;
            toChain: string;
            /** @description Source token info for this hop */
            fromToken: Record<string, never>;
            /** @description Destination token info for this hop */
            toToken: Record<string, never>;
            /** @description Estimated execution time in seconds for this step */
            estimatedTime: number;
            /** @description Estimated gas cost in the source token's base unit */
            estimatedGas: string;
        };
        RouteDto: {
            /** @description Ordered list of steps to execute the swap */
            steps: components["schemas"]["RouteStepDto"][];
            /** @description Total estimated time for all steps in seconds */
            totalTime: number;
            /** @description Total fees in USD across all steps */
            totalFeesUSD: number;
            /** @description Estimated price impact as a decimal fraction, e.g. 0.003 = 0.3% */
            priceImpact: number;
        };
        QuoteDto: {
            /** @description Solver address */
            solver: string;
            /** @description Solver name */
            solverName: string;
            /** @description Destination amount as a string */
            dstAmount: string;
            /** @description Protocol fee as a string */
            fee: string;
            /** @description Estimated fill time in seconds */
            fillTime: number;
            /** @description Unix timestamp when quote expires */
            expiresAt: number;
            /** @description Total fees in USD (protocol fee converted at token price) */
            totalFeesUSD: number;
            /** @description Estimated price impact as a decimal fraction, e.g. 0.003 = 0.3% */
            priceImpact: number;
            /** @description Computed execution route (direct single-step or multi-hop via USDC intermediate) */
            route: components["schemas"]["RouteDto"];
        };
        QuoteResponseDto: {
            /** @description Array of quotes sorted by best dstAmount first */
            quotes: components["schemas"]["QuoteDto"][];
            /** @description Best quote or null if no solvers available */
            bestQuote: components["schemas"]["QuoteDto"] | null;
            /** @description Source chain */
            srcChain: string;
            /** @description Source token symbol */
            srcTokenSymbol: string;
            /** @description Source amount as a string */
            srcAmount: string;
            /** @description Destination token symbol */
            dstTokenSymbol: string;
            /** @description Estimated fill time in seconds for the best quote */
            estimatedFillTime: number;
            /** @description Total fees in USD for the best quote (0 when no quote available) */
            totalFeesUSD: number;
            /** @description Price impact for the best quote as a decimal fraction (0 when no quote available) */
            priceImpact: number;
        };
        RegisterSolverDto: {
            /** @description Solver's Stellar address */
            address: string;
            /** @description Solver's display name */
            name: string;
            /** @description Bond amount as a non-negative integer string (in USDC base units) */
            bondAmount: string;
            /** @description Average fill time in seconds */
            avgFillTime: number;
            /** @description Chains this solver supports */
            supportedChains: ("stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche")[];
            /** @description Token symbols this solver supports */
            supportedTokens: unknown[][];
            /** @description Proof-of-control signature for the advertised solver address */
            proofSignature: string;
        };
        UpdateSolverDto: {
            /** @description New display name */
            name?: string;
            /** @description Replacement list of chains this solver supports */
            supportedChains?: ("stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche")[];
            /** @description Replacement list of supported token symbols */
            supportedTokens?: unknown[][];
            /** @description Updated average fill time in seconds */
            avgFillTime?: number;
            /** @description Base64-encoded Ed25519 signature of the message "update-solver:<address>" produced by the solver's private key, proving control of :address */
            signature: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    HealthController_check: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SorobanController_getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Soroban RPC node health status (pass-through of the RPC `getHealth` result). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example healthy */
                        status: string;
                        latestLedger?: number;
                        oldestLedger?: number;
                        ledgerRetentionWindow?: number;
                    };
                };
            };
        };
    };
    SorobanController_getLatestLedger: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Latest closed ledger as reported by the Soroban RPC node. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example 12345678 */
                        sequence: number;
                        protocolVersion?: number;
                    };
                };
            };
        };
    };
    SorobanController_getNetwork: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Network passphrase and protocol metadata for the configured RPC node. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        friendbotUrl?: string | null;
                        /** @example Test SDF Network ; September 2015 */
                        passphrase: string;
                        protocolVersion?: number;
                    };
                };
            };
        };
    };
    SorobanController_getAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Stellar Ed25519 account public key (starts with `G`, 56 characters). */
                publicKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description On-chain account record (id, sequence number, and balances). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example 987654321 */
                        sequence: string;
                        balances?: {
                            balance?: string;
                            asset_type?: string;
                        }[];
                    };
                };
            };
            /** @description Invalid Stellar public key format */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Per-account rate limit exceeded (AccountRateLimitGuard) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TokensController_getTokens: {
        parameters: {
            query?: {
                /** @description Restrict the result to a single chain (e.g. `stellar`, `ethereum`, `base`). When omitted, every supported chain plus the Stellar token list is returned. */
                chain?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supported tokens. With `chain` set, `{ tokens: Token[], chain }`; without it, `tokens` is keyed by chain and `stellarTokens` holds the Stellar list. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        tokens: {
                            address?: string;
                            contract?: string;
                            /** @example USDC */
                            symbol: string;
                            /** @example USD Coin */
                            name: string;
                            /** @example 6 */
                            decimals: number;
                            /** @example 1 */
                            priceUSD: number;
                        }[];
                        /** @example ethereum */
                        chain: string;
                    } | {
                        tokens: {
                            [key: string]: {
                                address: string;
                                /** @example USDC */
                                symbol: string;
                                /** @example USD Coin */
                                name: string;
                                /** @example 6 */
                                decimals: number;
                                /** @example 1 */
                                priceUSD: number;
                            }[];
                        };
                        stellarTokens: {
                            contract: string;
                            /** @example XLM */
                            symbol: string;
                            /** @example Stellar Lumens */
                            name: string;
                            /** @example 7 */
                            decimals: number;
                            /** @example 0.1182 */
                            priceUSD: number;
                        }[];
                    };
                };
            };
        };
    };
    TokensController_getStellarTokens: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The full list of supported Stellar destination tokens. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StellarTokensResponseDto"];
                };
            };
        };
    };
    IntentsController_list: {
        parameters: {
            query: {
                /** @description Filter by intent state */
                state?: string;
                /** @description Filter by user address */
                user?: string;
                /** @description Filter by source chain */
                chain?: string;
                /** @description Number of results per page */
                limit: number;
                /** @description Cursor for the next page of intents */
                cursor?: string;
                /** @description Number of results to skip */
                offset: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Invalid limit or offset */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_create: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateIntentDto"];
            };
        };
        responses: {
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Rate limit exceeded — max 10 intent creations per user per 60 s (or 100 req/min per IP globally) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_listOpen: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_listByUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_getOne: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Intent not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_getAudit: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Audit trail for the intent */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        intentId?: string;
                        entries?: {
                            /** Format: date-time */
                            timestamp?: string;
                            toState?: string;
                            actor?: string;
                            reason?: string;
                            metadata?: Record<string, never> | null;
                        }[];
                    };
                };
            };
            /** @description Intent not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_getPersistedQuote: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Persisted quote for the intent */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent not found or no quote persisted */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_accept: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AcceptIntentDto"];
            };
        };
        responses: {
            /** @description Solver not registered or inactive */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent is not in open state */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent has expired */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_fill: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FillIntentDto"];
            };
        };
        responses: {
            /** @description Fill amount below minimum */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Wrong solver for this intent */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent is not in accepted state */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Fill window has expired */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_cancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CancelIntentDto"];
            };
        };
        responses: {
            /** @description Unauthorized */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent is not in open state */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_quote: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuoteRequestDto"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuoteResponseDto"];
                };
            };
            /** @description Rate limit exceeded — max 20 quote requests per 60 s per IP */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_getLeaderboard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_register: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RegisterSolverDto"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_getSolver: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_updateSolver: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateSolverDto"];
            };
        };
        responses: {
            /** @description Updated solver record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid update body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid signature */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Solver not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_getSolverStats: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_deregisterSolver: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_deactivate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolversController_reactivate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    StatsController_getStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    StatsController_getWsStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
