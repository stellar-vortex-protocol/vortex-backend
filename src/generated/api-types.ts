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
        patch?: never;
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
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SorobanController_getAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                publicKey: string;
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
    TokensController_getTokens: {
        parameters: {
            query: {
                chain: string;
            };
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
    TokensController_getStellarTokens: {
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
            /** @description Rate limit exceeded — max 100 req/min per IP globally */
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
