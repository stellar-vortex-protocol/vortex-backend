# ADR 0004: Admin token registry with on-chain metadata checks

- **Status**: Accepted
- **Date**: 2026-09-29
- **Technical Story**: #435 — token registry admin API

## Context

Token decimals and symbols used to live in seed data. A wrong decimal silently
mis-prices every intent that uses that token. Adding a token required a deploy.

## Decision

`POST`, `PATCH` and `DELETE /api/v1/admin/tokens` are guarded by the existing
admin key (`x-admin-key`) and written to `admin_audit_log`.

Before a create, or a patch that sends symbol, decimals or name, a chain-family
verifier reads the authoritative metadata:

- EVM: `eth_getCode` plus `decimals()` and `symbol()`. `symbol()` accepts both
  ABI `string` and non-standard `bytes32`. `name()` is best-effort.
- Stellar classic (`CODE:G...` or `native`): 7 decimals, symbol is the asset
  code. These are not SACs.
- Stellar SAC (`C...`): read-only Soroban simulation of `symbol`, `decimals`
  and `name`, using `SHADOW_SOURCE_ACCOUNT` as the unsigned envelope source.

If the caller supplies a field that disagrees with the chain, the call returns
`METADATA_MISMATCH` and nothing is written. A missing contract returns
`TOKEN_NOT_FOUND` and nothing is written. RPC failures return 503 and nothing
is written.

Status is `active`, `paused` or `delisted`. Delete sets `delisted` and keeps
the row. Discovery hides delisted tokens. `resolveSrcToken` / `resolveDstToken`
still return them, so an intent that already copied the token can be accepted
and filled. New creates go through `resolve*OrThrow`, which rejects paused and
delisted tokens.

Successful writes replace the in-memory registry snapshot (the cache in front
of Postgres) and broadcast `token_list_updated` on the existing intent
WebSocket. There is no automated token-list ingestion.

## Rollback

Drop `tokens.status` and `tokens.asset_kind` and the `TokenStatus` enum. Intent
rows do not foreign-key tokens, so the drop does not cascade. Revert the admin
routes in the same release so clients stop calling them.

## Consequences

Operators need `EVM_RPC_URLS` for EVM verification and `SHADOW_SOURCE_ACCOUNT`
plus `SOROBAN_RPC_URL` for SAC verification. Classic assets do not need either.
A verification outage blocks new registrations; it does not block delist or
status-only patches, and it does not freeze intents that are already open.
