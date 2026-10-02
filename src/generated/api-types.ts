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
    "/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["MetricsController_index"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/killswitch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current kill-switch state and propagation health. */
        get: operations["KillSwitchController_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/killswitch/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause a scope. Effective on every replica within the propagation budget. */
        post: operations["KillSwitchController_pause"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/killswitch/resume/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve a resume. Takes effect once two distinct operators have approved. */
        post: operations["KillSwitchController_approveResume"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intents": {
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
    "/intents/open": {
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
    "/intents/user/{address}": {
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
    "/intents/{id}": {
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
    "/intents/{id}/audit": {
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
    "/intents/{id}/quote": {
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
    "/intents/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch-fetch current intent records by ID
         * @description Returns the current record for each supplied intent ID. IDs with no matching record are omitted (not individually 404'd). Capped at 100 IDs.
         */
        post: operations["IntentsController_batchLookup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intents/batch-create": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create multiple intents atomically
         * @description Creates up to 50 intents in a single atomic (all-or-nothing) request. If any item fails validation or exceeds open intent limits, zero intents are created and per-item errors are reported.
         */
        post: operations["IntentsController_batchCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intents/{id}/accept": {
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
    "/intents/{id}/fill": {
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
    "/intents/{id}/cancel": {
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
    "/intents/{id}/amend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["IntentsController_amend"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intents/quote": {
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
    "/intents/{id}/requote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-quote an existing open intent using its stored fields */
        post: operations["IntentsController_requote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/docs/ws": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * AsyncAPI specification for the Vortex WebSocket feed
         * @description Returns the AsyncAPI 2.6 YAML document describing the vortex.v1 subprotocol. Use this with AsyncAPI Studio or SDK generators.
         */
        get: operations["WsDocsController_getSpec"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SolversController_getLegacyLeaderboard"];
        put?: never;
        post: operations["SolversController_register"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/leaderboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Windowed solver leaderboard
         * @description Returns the ranked solver list for a specific window. This endpoint is intended for recent-performance visibility and does not alter the legacy all-time leaderboard.
         */
        get: operations["SolversController_getLeaderboard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/eligible-intents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SolversController_getEligibleIntents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}": {
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
    "/solvers/{address}/stats": {
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
    "/solvers/{address}/slashes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["SolversController_getSlashHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/slashes/{slashId}/dispute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["SolversController_submitDispute"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/slashes/{slashId}/dispute/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["SolversController_resolveDispute"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/deregister": {
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
    "/solvers/{address}/deactivate": {
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
    "/solvers/{address}/reactivate": {
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
    "/api/v1/admin/griefing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List solvers currently under anti-griefing enforcement */
        get: operations["SolverGriefingController_listEnforced"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/griefing/{address}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get anti-griefing record for a solver */
        get: operations["SolverGriefingController_getSolverRecord"];
        put?: never;
        post?: never;
        /** Reset a solver's anti-griefing state to ok */
        delete: operations["SolverGriefingController_resetSolver"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/griefing/{address}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get anti-griefing audit log for a solver */
        get: operations["SolverGriefingController_getSolverAudit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/griefing/{address}/exclude/{intentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Exclude an incident intent from griefing ratio */
        post: operations["SolverGriefingController_excludeIncident"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tokens": {
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
    "/tokens/stellar": {
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
    "/chain/health": {
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
    "/chain/ledger": {
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
    "/chain/network": {
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
    "/chain/account/{publicKey}": {
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
    "/admin/shadow-report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Daily shadow-mode divergence summary
         * @description Returns (expected, simulated) comparison counts for on-chain simulations run in parallel with the off-chain intent path, broken down by transition and by divergence reason, plus a per-UTC-day series and shadow queue health. Headline totals are lifetime-to-date; `days` bounds only the per-day breakdown.
         */
        get: operations["ShadowController_shadowReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/params": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Current and pending governance-controlled protocol parameters
         * @description Returns the actively-enforced protocol parameters, any pending governance change with its timelock execution ledger and ETA, and recent parameter history. Parameters are sourced from the on-chain governance contract when PARAMS_CONTRACT_ID is configured; code/env defaults are used otherwise.
         */
        get: operations["ParamsController_getParams"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/governance/guardian/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Active guardian actions (with tx references) and effective pause state */
        get: operations["GuardianController_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/governance/guardian/actions/{id}/override": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Superadmin override of an active guardian action (audited) */
        post: operations["GuardianController_override"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a solver's credentials
         * @description Lists credential metadata (never plaintext) for the authenticated solver.
         */
        get: operations["SolverCredentialController_list"];
        put?: never;
        /**
         * Create a scoped solver credential
         * @description Mints a new scoped credential for the authenticated solver. The plaintext secret is returned ONCE. Requires a valid SEP-10 JWT for the solver.
         */
        post: operations["SolverCredentialController_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/credentials/{id}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate a solver credential
         * @description Revokes the credential and issues a replacement with the same scopes. The new plaintext is returned ONCE.
         */
        post: operations["SolverCredentialController_rotate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/solvers/{address}/credentials/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke a solver credential
         * @description Instantly revokes the credential and propagates to all replicas.
         */
        post: operations["SolverCredentialController_revoke"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/jobs/queues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Depth and dead-letter counts per queue */
        get: operations["JobsController_queues"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/jobs/queues/{queue}/dead-letters": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Most recent dead-lettered jobs for a queue */
        get: operations["JobsController_deadLetters"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/flags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Managed flags with env default, override pin and stored rules */
        get: operations["FlagsController_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/flags/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set a flag's default and targeting rules
         * @description Returns 202-style { status: 'pending' } when a second approval is required.
         */
        put: operations["FlagsController_update"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/flags/change-requests/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve a pending change (must be a different admin than the proposer) */
        post: operations["FlagsController_approve"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/flags/{key}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Audit trail for a flag, newest first */
        get: operations["FlagsController_auditLog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["HealthController_live"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["HealthController_ready"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/startup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["HealthController_startup"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
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
    "/stats": {
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
    "/stats/treasury": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["StatsController_getTreasuryStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stats/ws": {
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
    "/treasury/reconciliation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get treasury reconciliation summary
         * @description Returns daily reconciliation summary showing expected vs actual balances per asset
         */
        get: operations["TreasuryController_getReconciliation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/treasury/reconciliation/{asset}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get detailed reconciliation for an asset
         * @description Returns detailed reconciliation data including transaction breakdown
         */
        get: operations["TreasuryController_getAssetReconciliation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/treasury/reconciliation/trigger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Manually trigger treasury reconciliation
         * @description Admin endpoint to trigger reconciliation on-demand
         */
        post: operations["TreasuryController_triggerReconciliation"];
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
        PauseKillSwitchDto: {
            /**
             * @description Breadth of the pause.
             * @enum {string}
             */
            scope: "global" | "chain" | "token" | "operation";
            /** @description Required for chain/token/operation scope. */
            chain?: string;
            /** @description Required for token scope; wildcard for operation scope. */
            token?: string;
            /**
             * @description Required for operation scope.
             * @enum {string}
             */
            operation?: "create" | "accept" | "fill" | "slash" | "onchain";
            /** @enum {string} */
            reasonCode: "INCIDENT" | "TOKEN_DEPEGGED" | "SOLVER_INCIDENT" | "CHAIN_DEGRADED" | "RPC_DEGRADED" | "REGULATORY" | "MAINTENANCE";
            /** @description Operator explanation, shown to clients and in the audit log. */
            reason: string;
        };
        ApproveResumeDto: {
            /** @description Why the resume is safe. */
            note?: string;
            /**
             * @description Distinct approvals needed.
             * @default 2
             */
            approvalsRequired: number;
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
        BatchLookupDto: {
            /** @description Intent IDs to look up (max 100). IDs with no matching record are omitted from the response, not individually 404'd. */
            intentIds: string[];
        };
        BatchCreateIntentsDto: {
            /** @description List of intents to create atomically (1..50) */
            intents: components["schemas"]["CreateIntentDto"][];
        };
        BatchCreateItemErrorDto: {
            /** @description Zero-based index of the failed intent item in the input array */
            index: number;
            /** @description Field name associated with the error, if applicable */
            field?: string;
            /** @description Human-readable error description */
            message: string;
        };
        BatchCreateIntentsResponseDto: {
            /** @description Array of created Intent objects when successful */
            created: string[];
            /** @description List of per-item validation errors if any failed */
            errors: components["schemas"]["BatchCreateItemErrorDto"][];
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
        AmendIntentDto: {
            /** @description Stellar address of the intent's original creator (must match) */
            user: string;
            /** @description Replacement minimum destination amount in base units */
            minDstAmount: string;
            /** @description Replacement Unix timestamp deadline */
            deadline: number;
            /** @description Base64 Ed25519 signature of "amend:<intentId>:<user>:<minDstAmount>:<deadline>" */
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
            /** @description True when no solver responded and the returned quote is indicative */
            indicative?: boolean;
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
        UpdateSolverStatusDto: {
            /** @description Proof-of-control signature for the solver status update */
            signature: string;
        };
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
        GuardianOverrideDto: Record<string, never>;
        CreateSolverCredentialDto: {
            /**
             * @description Scopes granted to the credential
             * @enum {string}
             */
            scopes: "solver:read" | "intents:read" | "quote:respond" | "intents:accept" | "intents:fill";
            /** @description Optional source-address allowlist. Entries are an exact IPv4 address, an IPv4 CIDR block, an exact IPv6 address, or `*` for any source. IPv6 CIDR blocks and hostnames are not supported; an entry that does not parse never matches, so a typo locks the credential out rather than opening it up. */
            ipAllowlist?: string[];
            /** @description Unix epoch seconds at which the credential expires (null = never) */
            expiresAt?: number;
        };
        UpdateFlagDto: Record<string, never>;
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    MetricsController_index: {
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
    KillSwitchController_status: {
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
    KillSwitchController_pause: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PauseKillSwitchDto"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    KillSwitchController_approveResume: {
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
                "application/json": components["schemas"]["ApproveResumeDto"];
            };
        };
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
            query?: {
                /** @description Filter by intent state */
                state?: "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed" | "pending_open" | "pending_accepted" | "pending_filled" | "pending_cancelled";
                /** @description Filter by user address */
                user?: string;
                /** @description Filter by source chain */
                chain?: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
                /** @description Number of results per page (max 100) */
                limit?: number;
                /** @description Cursor for the next page of intents */
                cursor?: string;
                /** @description Number of results to skip */
                offset?: number;
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
            /** @description Open-intent cap reached — a single user may not hold more than 50 open/accepted intents simultaneously */
            409: {
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
            query?: {
                /** @description Filter by intent state */
                state?: "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed" | "pending_open" | "pending_accepted" | "pending_filled" | "pending_cancelled";
                /** @description Filter by user address */
                user?: string;
                /** @description Filter by source chain */
                chain?: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
                /** @description Number of results per page (max 100) */
                limit?: number;
                /** @description Cursor for the next page of intents */
                cursor?: string;
                /** @description Number of results to skip */
                offset?: number;
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
    IntentsController_listByUser: {
        parameters: {
            query?: {
                /** @description Filter by intent state */
                state?: "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed" | "pending_open" | "pending_accepted" | "pending_filled" | "pending_cancelled";
                /** @description Filter by user address */
                user?: string;
                /** @description Filter by source chain */
                chain?: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
                /** @description Number of results per page (max 100) */
                limit?: number;
                /** @description Cursor for the next page of intents */
                cursor?: string;
                /** @description Number of results to skip */
                offset?: number;
            };
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
            query?: {
                /** @description Filter by intent state */
                state?: "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed" | "pending_open" | "pending_accepted" | "pending_filled" | "pending_cancelled";
                /** @description Filter by user address */
                user?: string;
                /** @description Filter by source chain */
                chain?: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
                /** @description Number of results per page (max 100) */
                limit?: number;
                /** @description Cursor for the next page of intents */
                cursor?: string;
                /** @description Number of results to skip */
                offset?: number;
            };
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
    IntentsController_batchLookup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchLookupDto"];
            };
        };
        responses: {
            /** @description Records for the found intent IDs, plus a count */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description intentIds missing, not an array of strings, or exceeds 100 entries */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    IntentsController_batchCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchCreateIntentsDto"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchCreateIntentsResponseDto"];
                };
            };
            /** @description Invalid request payload or empty batch */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Per-item validation errors or limits exceeded */
            422: {
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
            /** @description An emergency kill-switch is active for this intent's scope (503 + Retry-After) */
            503: {
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
    IntentsController_amend: {
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
                "application/json": components["schemas"]["AmendIntentDto"];
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
            /** @description Intent is not amendable */
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
    IntentsController_requote: {
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
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuoteResponseDto"];
                };
            };
            /** @description Intent not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Intent is not in the open state */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
    WsDocsController_getSpec: {
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
    SolversController_getLegacyLeaderboard: {
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
    SolversController_getLeaderboard: {
        parameters: {
            query?: {
                window?: "24h" | "7d" | "30d" | "all";
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
    SolversController_getEligibleIntents: {
        parameters: {
            query?: {
                /** @description Filter by intent state */
                state?: "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed" | "pending_open" | "pending_accepted" | "pending_filled" | "pending_cancelled";
                /** @description Filter by user address */
                user?: string;
                /** @description Filter by source chain */
                chain?: "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche";
                /** @description Number of results per page (max 100) */
                limit?: number;
                /** @description Cursor for the next page of intents */
                cursor?: string;
                /** @description Number of results to skip */
                offset?: number;
            };
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
            query: {
                window: string;
            };
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
    SolversController_getSlashHistory: {
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
    SolversController_submitDispute: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
                slashId: string;
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
    SolversController_resolveDispute: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
                slashId: string;
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
    SolversController_deregisterSolver: {
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
                "application/json": components["schemas"]["UpdateSolverStatusDto"];
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
    SolversController_deactivate: {
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
                "application/json": components["schemas"]["UpdateSolverStatusDto"];
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
    SolversController_reactivate: {
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
                "application/json": components["schemas"]["UpdateSolverStatusDto"];
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
    SolverGriefingController_listEnforced: {
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
    SolverGriefingController_getSolverRecord: {
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
    SolverGriefingController_resetSolver: {
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
    SolverGriefingController_getSolverAudit: {
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
    SolverGriefingController_excludeIncident: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
                intentId: string;
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
    ShadowController_shadowReport: {
        parameters: {
            query?: {
                /** @description Trailing UTC days of per-day breakdown to include (1-90, default 1). */
                days?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Shadow-mode divergence report */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        enabled?: boolean;
                        sampleRate?: number;
                        /** @example 2026-09-30 */
                        day?: string;
                        /** Format: date-time */
                        generatedAt?: string;
                        compared?: number;
                        diverged?: number;
                        divergenceRate?: number;
                        transitions?: {
                            /** @example accept */
                            transition?: string;
                            compared?: number;
                            diverged?: number;
                            divergenceRate?: number;
                        }[];
                        divergences?: {
                            /** @example fill */
                            transition?: string;
                            /**
                             * @example outcome_mismatch
                             * @enum {string}
                             */
                            reason?: "outcome_mismatch" | "simulation_error" | "simulation_exception" | "contract_unconfigured";
                            count?: number;
                        }[];
                        daily?: {
                            /** @example 2026-09-30 */
                            day?: string;
                            compared?: number;
                            diverged?: number;
                            divergenceRate?: number;
                            cells?: Record<string, never>[];
                        }[];
                        queue?: {
                            depth?: number;
                            capacity?: number;
                            dropped?: number;
                            sampledOut?: number;
                            disabled?: number;
                            completed?: number;
                        };
                    };
                };
            };
        };
    };
    ParamsController_getParams: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Protocol parameters — current, pending, and history */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Currently active protocol parameters */
                        current: {
                            /** @example 3 */
                            version: number;
                            /**
                             * @description Protocol fee in basis points
                             * @example 30
                             */
                            feeBps: number;
                            /** @description Per-chain deadline and fill-window overrides */
                            chains: {
                                [key: string]: {
                                    /** @example 900 */
                                    deadlineSeconds?: number;
                                    /** @example 120 */
                                    fillWindowSeconds?: number;
                                };
                            };
                            /**
                             * @description Maximum on-chain exposure ratio (0–1)
                             * @example 0.05
                             */
                            maxExposureRatio: number;
                            /** @example 100000000 */
                            slashAmount: string;
                            /** @example 12345678 */
                            activeSinceLedger: number;
                            /** Format: date-time */
                            adoptedAt: string;
                        };
                        /** @description Scheduled governance change not yet activated, or null */
                        pending: ({
                            params?: Record<string, never>;
                            /** @example 12349999 */
                            executionLedger?: number;
                            /**
                             * Format: date-time
                             * @description Best-effort ETA for timelock execution
                             */
                            estimatedEta?: string;
                            /** Format: date-time */
                            observedAt?: string;
                        } | null) | null;
                        /** @description Previous parameter versions, newest-first (max 50) */
                        history: Record<string, never>[];
                    };
                };
            };
        };
    };
    GuardianController_status: {
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
    GuardianController_override: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GuardianOverrideDto"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolverCredentialController_list: {
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
            /** @description Credential metadata list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid SEP-10 JWT */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolverCredentialController_create: {
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
                "application/json": components["schemas"]["CreateSolverCredentialDto"];
            };
        };
        responses: {
            /** @description Credential created (plaintext shown once) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid SEP-10 JWT */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolverCredentialController_rotate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateSolverCredentialDto"];
            };
        };
        responses: {
            /** @description Credential rotated (new plaintext shown once) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid SEP-10 JWT */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SolverCredentialController_revoke: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                address: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Credential revoked */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid SEP-10 JWT */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    JobsController_queues: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
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
    JobsController_deadLetters: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
            path: {
                queue: string;
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
    FlagsController_list: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
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
    FlagsController_update: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateFlagDto"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    FlagsController_approve: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
            path: {
                id: string;
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
    FlagsController_auditLog: {
        parameters: {
            query?: never;
            header: {
                "x-admin-key": string;
            };
            path: {
                key: string;
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
    HealthController_live: {
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
    HealthController_ready: {
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
    HealthController_startup: {
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
    StatsController_getTreasuryStats: {
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
    TreasuryController_getReconciliation: {
        parameters: {
            query?: {
                /** @description Date in YYYY-MM-DD format (defaults to today) */
                date?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reconciliation summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 2026-09-28 */
                        date?: string;
                        assets?: {
                            /** @example native */
                            asset?: string;
                            /** @example 1000000000 */
                            expectedBalance?: string;
                            /** @example 1000500000 */
                            actualBalance?: string;
                            /** @example 500000 */
                            discrepancy?: string;
                            /** @example 0.05 */
                            discrepancyPercentage?: number;
                            /** @example false */
                            hasUnexplainedDiscrepancy?: boolean;
                            explanation?: string | null;
                        }[];
                        /** @example 3 */
                        totalDiscrepancies?: number;
                        /** @example 1 */
                        assetsWithUnexplainedDiscrepancies?: number;
                        /** @example 2026-09-28T00:00:00.000Z */
                        lastReconciliationAt?: string;
                    };
                };
            };
        };
    };
    TreasuryController_getAssetReconciliation: {
        parameters: {
            query?: {
                /** @description Date in YYYY-MM-DD format (defaults to today) */
                date?: string;
            };
            header?: never;
            path: {
                /** @description Asset identifier (e.g., 'native', 'USDC:ISSUER', or contract address) */
                asset: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Detailed reconciliation data */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 2026-09-28 */
                        snapshotDate?: string;
                        /** @example native */
                        asset?: string;
                        /** @example 1000000000 */
                        expectedBalance?: string;
                        /** @example 1000500000 */
                        actualBalance?: string;
                        /** @example 500000 */
                        discrepancy?: string;
                        /** @example 0.05 */
                        discrepancyPercentage?: number;
                        /** @example 10000000 */
                        toleranceThreshold?: string;
                        /** @example false */
                        hasUnexplainedDiscrepancy?: boolean;
                        explanation?: string | null;
                        breakdown?: {
                            /** @example 500000000 */
                            fees?: string;
                            /** @example 100000000 */
                            slashes?: string;
                            /** @example 50000000 */
                            refunds?: string;
                        };
                        recentTransactions?: {
                            /** @enum {string} */
                            type?: "fee" | "slash" | "refund";
                            /** @example 1000000 */
                            amount?: string;
                            /** @example 2026-09-28T12:00:00.000Z */
                            timestamp?: string;
                            /** @example intent-uuid */
                            reference?: string;
                        }[];
                    };
                };
            };
        };
    };
    TreasuryController_triggerReconciliation: {
        parameters: {
            query?: {
                /** @description Specific asset to reconcile (reconciles all if omitted) */
                asset?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reconciliation completed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example Reconciliation completed */
                        message?: string;
                        results?: {
                            asset?: string;
                            hasUnexplainedDiscrepancy?: boolean;
                            discrepancy?: string;
                        }[];
                    };
                };
            };
        };
    };
}
