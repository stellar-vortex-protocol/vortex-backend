# Solver Onboarding & Operations Guide

This guide walks prospective and active solver operators through the full lifecycle of operating a solver on the Vortex Protocol: registration, bond management, bot authentication, real-time WebSocket topic subscriptions, and handling deactivation or slashing penalties.

---

## Architecture Overview

Solvers in Vortex act as execution liquidity providers. They monitor cross-chain intent creations, lock in intent fulfillment by accepting them, and complete the settlement across supported destination chains.

```
┌─────────────────┐       1. POST /solvers/register        ┌─────────────────────────┐
│                 ├───────────────────────────────────────►│                         │
│                 │       2. Deposit Bond (Soroban)        │                         │
│  Solver Bot /   ├───────────────────────────────────────►│                         │
│  Operator       │       3. Connect & Sub /ws             │   Vortex Backend API    │
│                 ├───────────────────────────────────────►│                         │
│                 │       4. Accept & Fill Intent (Signed) │                         │
│                 ├───────────────────────────────────────►│                         │
└─────────────────┘                                        └────────────┬────────────┘
                                                                        │
                                                               5. Sweeper Monitor
                                                                  Slash on Timeout
                                                                        ▼
                                                           ┌─────────────────────────┐
                                                           │ Soroban Solver Registry │
                                                           │ Contract                │
                                                           └─────────────────────────┘
```

---

## 1. Solver Registration

Before a solver can accept or fill intents on Vortex, it must register its Stellar G-address, solver identity name, supported chains, supported tokens, and initial bond details with the API.

### Authentication & Proof of Control
To prevent unauthorized actors from registering addresses they do not control, registration requires a cryptographic signature. The solver must sign a canonical message using its private key:

```text
register:<solverAddress>
```

- **Message format**: `register:G...` (Stellar public key)
- **Signature**: Base64-encoded 64-byte Ed25519 signature produced by signing the UTF-8 bytes of the message with the solver's Stellar secret key (`Keypair.sign(Buffer.from(message, 'utf8'))`).

### HTTP Request
`POST /api/v1/solvers/register`

**Payload (`RegisterSolverDto`)**:
```json
{
  "address": "GBCW6A5K76DMT5Y55LVTG62W4VRV5L45I2N374X63P3V...",
  "name": "Alpha-Liquidity-Solver",
  "bondAmount": "1000000000",
  "supportedChains": ["stellar", "ethereum", "polygon", "arbitrum"],
  "supportedTokens": ["USDC", "XLM", "ETH"],
  "signature": "base64EncodedSignatureString=="
}
```

**Response (`201 Created`)**:
```json
{
  "address": "GBCW6A5K76DMT5Y55LVTG62W4VRV5L45I2N374X63P3V...",
  "name": "Alpha-Liquidity-Solver",
  "bondAmount": "1000000000",
  "isActive": false,
  "supportedChains": ["stellar", "ethereum", "polygon", "arbitrum"],
  "supportedTokens": ["USDC", "XLM", "ETH"],
  "fillsCompleted": 0,
  "fillsFailed": 0,
  "totalVolume": "0",
  "avgFillTime": 0,
  "registeredAt": 1775836800
}
```

---

## 1a. Updating Your Solver Profile

Once registered, a solver operator can edit their **mutable** profile fields as
their operation scales — for example adding a newly-supported chain or fixing a
typo in the display name — without re-registering.

### HTTP Request
`PATCH /api/v1/solvers/:address`

- **Authentication**: same proof-of-control convention as registration. Sign the
  UTF-8 bytes of the message `update-solver:G...` (the `:address` path segment)
  with the solver's Stellar secret key and send the base64 signature in the body.
- **Editable fields**: `name`, `supportedChains`, `supportedTokens`, `avgFillTime`
  (all optional — send only what changes). Arrays are replaced wholesale.
- **Immutable fields** (`address`, `bondAmount`, `fillsCompleted`, `fillsFailed`,
  `totalVolume`, `registeredAt`, `isActive`) are silently stripped by the
  request validator; sending them is a no-op, not an error. Bond changes are an
  on-chain concern — see section 2.

**Payload (`UpdateSolverDto`)**:
```json
{
  "name": "Alpha-Liquidity-Solver",
  "supportedChains": ["stellar", "ethereum", "polygon", "arbitrum", "base"],
  "supportedTokens": ["USDC", "XLM", "ETH", "WBTC"],
  "avgFillTime": 38,
  "signature": "base64EncodedSignatureString=="
}
```

**Responses**: `200 OK` with the updated solver record; `400` for an invalid
body (e.g. an unsupported chain or a missing signature); `401` for a bad or
mismatched signature; `404` when `:address` is not a registered solver.

---

## 2. Bond Posting & On-Chain Enforcement

### Posting a Bond
Solvers must maintain a collateral bond in the Soroban `SolverRegistryContract` (`SOLVER_REGISTRY_CONTRACT_ID`) to guarantee intent execution.
- **Minimum Bond Requirement**: Solvers cannot accept high-value intents without adequate active collateral.
- **On-Chain Settlement**: Bond balances are recorded on-chain via the Soroban contract and synchronized with the backend registry.

### Bond and Exposure Checks on Acceptance
Every accept request verifies the solver's bond amount and active status against
the registry contract through a read-only Soroban simulation. A successful
result is cached for at most 30 seconds and registry bond/activity events
invalidate the cache. If the registry RPC, contract, or response is unavailable,
the API fails closed with `503`; the projected `bondAmount` in the backend
solver record is not used as a substitute.

The backend values the intent's source amount in USD using integer arithmetic
and enforces this ceiling before the state transition:

> accepted exposure in USD + new intent value in USD ≤ on-chain bond value in USD × `maxExposureRatio`

`maxExposureRatio` is the current governance parameter. Stellar bond amounts are
interpreted in 7-decimal XLM base units and valued using the configured XLM USD
price. An intent price snapshot older than five minutes, a missing/non-positive
price, or malformed amount fails closed with `503`. An intent exceeding the
remaining capacity is rejected with `403` and error code `INSUFFICIENT_BOND`.
Bond top-ups remain an on-chain operation and are outside this API flow.

### Reputation & Bond Reconciliation
A solver's active reputation score is continuously computed using completion rates and account age:
$$\text{ReputationScore} = \text{SuccessRate} \times e^{-\frac{\text{AgeInDays}}{180}}$$
where $\text{SuccessRate} = \frac{\text{fillsCompleted}}{\text{fillsCompleted} + \text{fillsFailed}}$.

---

## 2a. SEP-10 Bot Authentication (Short-Lived Session Tokens)

Bots authenticate to the API and the WebSocket feed with a SEP-10-style
challenge instead of a long-lived shared secret. You request a challenge,
sign it with your solver account key(s), and exchange it for a **15-minute
EdDSA session token** (`issue #442`). Signed-message endpoints from
§3b (`accept`/`fill` signatures) are unchanged — this flow only governs
*connection* authentication (WebSocket feed, scoped credential endpoints).

### Step 1 — Request a challenge

```
GET /api/v1/auth/challenge?account=G...
```

```bash
curl "$BACKEND_URL/api/v1/auth/challenge?account=$SOLVER_ADDRESS"
```

```json
{
  "transaction": "AAAAAgAAAAB...base64XDR...",
  "network_passphrase": "Test SDF Network ; September 2015"
}
```

The transaction is a server-signed SEP-10 challenge: a `manageData`
operation `<home-domain> auth` carrying a single-use 48-byte nonce (source =
your account), a `web_auth_domain` operation, and 5-minute time bounds.

### Step 2 — Sign and exchange

Sign the transaction with the account's key(s) — for multisig accounts, sign
with enough signers to meet the account's **medium threshold** (floored at
1) — then POST the signed XDR back:

```bash
curl -X POST "$BACKEND_URL/api/v1/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"transaction\": \"$SIGNED_CHALLENGE_XDR\"}"
```

```json
{
  "token": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 900
}
```

The JWT carries `sub` (your G-address), `role` (`solver` when the account is
registered, `user` otherwise, `admin` for accounts listed in
`SEP10_ADMIN_ACCOUNTS`), `jti` (a unique token id), `iat`, and `exp`. It is
signed with the Ed25519 key `SEP10_JWT_SIGNING_KEY` (never with the Soroban
signer key).

**Each challenge is single-use.** A captured challenge cannot be exchanged
twice; failed exchanges (bad signature, wrong threshold) do not consume it.
A challenge is valid for 5 minutes (+300s clock-drift grace); after that,
request a fresh one. There is no refresh token — simply re-run the flow when
you receive a `401` or `auth_error`.

### Using the token

- **REST**: `Authorization: Bearer <token>` on guarded endpoints (e.g. the
  solver-scoped credential routes).
- **WebSocket**: pass the token at handshake as `ws://host/ws?token=<token>`
  (or an `Authorization: Bearer` header), **or** as the first message after
  connecting:

```json
{ "type": "auth", "token": "<token>" }
```

On success the gateway binds your solver identity to the connection
(capability-filtered snapshot, `auth_ok`); on failure it replies with
`{ "type": "auth_error", "reason": "..." }`. Legacy HS256 tokens signed with
`AUTH_JWT_SECRET` remain accepted during migration.

### Revoking a session token early

If a session token leaks (logged accidentally, exposed via a misconfigured
proxy, etc.) you can kill it before its natural expiry:

```
POST /api/v1/auth/revoke
Authorization: Bearer <token>
```

The token being revoked is itself the credential — no body is required. The
server records the token's `jti` claim in a Redis-backed denylist with a TTL
equal to the token's remaining lifetime (never longer than
`SEP10_JWT_TTL_SECONDS`), so the denylist prunes itself. Every
JWT-authenticated guard checks the denylist before accepting a token, on every
replica, so revocation takes effect immediately across the fleet.

**Responses**: `204 No Content` on success (including revoking an
already-revoked token — revocation is idempotent); `401` if the token is
missing, malformed, or already expired.

Notes:

- Revocation is **single-token only**. Other sessions issued to the same
  account remain valid until their own expiry or until you revoke each one.
  To disable *all* credentials for a solver, use the bulk
  `disableAllForSolver` path in `SolverCredentialService` instead.
- A revoked token stays revoked until its natural `exp`; there is no
  un-revoke. Simply re-run the challenge/token flow to obtain a fresh token.

### Discovering the auth endpoint (SEP-1 `stellar.toml`)

Standard SEP-10 clients (wallets, SDKs) discover the auth endpoint and signing
key by fetching `https://<home_domain>/.well-known/stellar.toml` rather than
hardcoding the URL. The API serves this document:

```
GET /.well-known/stellar.toml
```

Content type is `application/toml` (with a `text/plain` fallback for clients
that do not negotiate TOML). The document publishes the fields SEP-10 clients
need:

| Field | Source | Meaning |
|---|---|---|
| `WEB_AUTH_ENDPOINT` | `SEP10_HOME_DOMAIN` | URL of `POST /api/v1/auth/token` (the token exchange). |
| `SIGNING_KEY` | `Sep10KeyMaterial.challenge.publicKey()` | Public key that signs challenges; clients verify the challenge transaction against it. |
| `NETWORK_PASSPHRASE` | `STELLAR_NETWORK` (`NETWORK_PASSPHRASES`) | Passphrase of the network the challenge is valid on (testnet vs. mainnet). |

The values are derived entirely from existing configuration — no new secrets
are introduced. `CURRENCIES` and `DOCUMENTATION` sections are intentionally
not published; this document exists solely for SEP-10 auth discovery.

### Key management

```bash
# Generate the JWT signing key (keep it out of version control):
openssl genpkey -algorithm ed25519 -out sep10-jwt.pem
# Base64 DER also works:
openssl genpkey -algorithm ed25519 | tail -n +2 | tr -d '\n'
```

| Env var | Purpose |
|---|---|
| `STELLAR_SIGNER_SECRET_KEY` | Server keypair that signs challenges (reuse of the existing Soroban signer config). |
| `SEP10_JWT_SIGNING_KEY` | Ed25519 PKCS#8 key signing the session JWTs. **Required in production.** |
| `SEP10_HOME_DOMAIN` | Home domain embedded in challenges (default `localhost`). |
| `SEP10_ADMIN_ACCOUNTS` | Comma-separated G-addresses issued `role=admin`. |
| `SEP10_NONCE_STORE` | `memory` (default, single replica) or `redis` (multi-replica replay protection). |
| `STELLAR_NETWORK` | Selects the `NETWORK_PASSPHRASE` published in `stellar.toml` (testnet vs. mainnet). |

Notes:

- The client account must exist on the network (unfunded/pre-authorized
  accounts are out of scope for solver auth).
- Deployments with more than one replica **must** set `SEP10_NONCE_STORE=redis`,
  otherwise a challenge issued by one replica could be replayed on another.
- The challenge's `web_auth_domain` and `<domain> auth` key both come from
  `SEP10_HOME_DOMAIN`; set it to your real API domain in production. The same
  value drives `WEB_AUTH_ENDPOINT` in `/.well-known/stellar.toml`.
- The session-token denylist used by `POST /api/v1/auth/revoke` is Redis-backed
  in production; single-replica dev/test deployments fall back to an in-memory
  store (same dual-adapter pattern as `SEP10_NONCE_STORE`).

---

## 3. Bot Connection, Authentication & WebSocket Topics

### Connecting to the Real-Time Feed
Solvers connect to the real-time intent WebSocket feed at:
`ws://<backend-host>/ws` (or `wss://`)

### Topic-Based Chain Subscriptions
To optimize bandwidth and processing efficiency, solvers can subscribe only to specific chains they support:
```json
{
  "type": "subscribe",
  "chains": ["stellar", "ethereum"]
}
```
Upon subscription, the WebSocket server responds with a `subscribed` event:
```json
{
  "type": "subscribed",
  "filter": {
    "chains": ["stellar", "ethereum"]
  }
}
```
Subsequent `intent_created` events will only be broadcast to the bot if the intent's `srcChain` matches one of the subscribed chains.

### RFQ Quote Requests
Authenticated, active solvers with a positive bond and matching source-chain/token capabilities may receive a short-lived `rfq_request` over this WebSocket. The default response window is 300 ms and can be configured from 1 to 1,000 ms with `QUOTE_AUCTION_WINDOW_MS`.

```json
{
  "type": "rfq_request",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "srcChain": "ethereum",
  "srcTokenSymbol": "USDC",
  "srcAmount": "1000000",
  "dstTokenSymbol": "USDC",
  "deadline": 1775836800300
}
```

Reply before `deadline` with the gross destination amount, solver fee, expiry in Unix seconds, and a Stellar Ed25519 signature:

```json
{
  "type": "rfq_response",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "dstAmount": "998500",
  "fee": "100",
  "expiresAt": 1775836860,
  "signature": "base64EncodedSignatureString=="
}
```

Sign the UTF-8 bytes of `vortex:rfq:v1:<requestId>:<payloadHash>`. `payloadHash` is the lowercase SHA-256 hex digest of the JSON encoding of the request fields (`requestId`, `srcChain`, `srcTokenSymbol`, `srcAmount`, `dstTokenSymbol`, optional `srcTokenAddress` and `dstTokenContract`, and `deadline`) plus `solver`, `dstAmount`, `fee`, and `expiresAt`. Omit absent optional fields and sort keys lexicographically before `JSON.stringify`. The signature is Base64-encoded. The backend accepts one valid response per solver and request; late, expired, malformed, or invalidly signed responses are ignored.

Quotes are ranked by destination amount after solver and protocol fees, with reputation breaking ties. If no valid solver response arrives within the window, the API returns the existing model-based estimate with `indicative: true`; otherwise `indicative` is false.

### Event Replay & Reconnection
On connection or reconnection, the bot can request event replay from its last received sequence ID (`seq`) to avoid missing intents during network blips:
```json
{
  "event": "replay",
  "data": {
    "fromSeq": 42
  }
}
```

### Accepting & Filling Intents with Auth Signatures

When a solver sees an open intent, it performs 2 steps:

#### Step 3a: Accept Intent
`POST /api/v1/intents/:id/accept`

- **Canonical Message to Sign**: `accept:<intentId>:<solverAddress>`
- **Request Body**:
```json
{
  "solver": "GBCW6A5K76DMT5Y55LVTG62W4VRV5L45I2N374X63P3V...",
  "signature": "base64EncodedSignatureOverAcceptMessage=="
}
```
This transitions the intent state from `open` to `accepted` and assigns the solver.

#### Step 3b: Fill Intent
`POST /api/v1/intents/:id/fill`

- **Canonical Message to Sign**: `fill:<intentId>:<solverAddress>`
- **Request Body**:
```json
{
  "solver": "GBCW6A5K76DMT5Y55LVTG62W4VRV5L45I2N374X63P3V...",
  "fillAmount": "1000000",
  "txHash": "64-character Stellar transaction hash",
  "signature": "base64EncodedSignatureOverFillMessage=="
}
```
The backend checks the transaction through Horizon before it transitions the intent to `filled`.
The transaction must be successful, carry a text memo equal to the intent UUID, and contain
a matching payment to the intent's Stellar user in the configured destination asset. Path
payments are credited using `destination_amount`; the submitted `fillAmount` is not used as
the protocol credit amount. Transactions not indexed yet remain pending and the solver may
retry the same hash. The hash is reserved to one intent by a database unique index.

**Current verification boundary:** classic Horizon `payment` and strict-send/strict-receive
path-payment operations are supported. Soroban `invoke_host_function` transfer events are
not yet verified, so SAC transfers submitted through contract invocation are rejected as
having no matching payment.
The current solver lifecycle still uses `isActive`; probation, bond verification, automatic
promotion/suspension, and SLA digests are not implemented by this change.

---

## 4. Deactivation, Downtime & Slashing Policy

### Voluntary Deactivation & Reactivation
Solvers can take themselves offline for maintenance or fund rebalancing:
- **Deactivate**: `POST /api/v1/solvers/:address/deactivate` (sets `isActive: false`, prevents accepting new intents).
- **Reactivate**: `POST /api/v1/solvers/:address/reactivate` (sets `isActive: true`).

### Automated Slashing for Missed Deadlines
The backend runs an automated sweeper service (`IntentsSweeperService`) every 30 seconds.

1. **Expiry Detection**: If an intent in `accepted` state exceeds its `deadline` timestamp before being filled, the sweeper marks the intent as `expired`.
2. **Failure Increment**: The solver's local `fillsFailed` counter is incremented immediately.
3. **On-Chain Slash Invocation**: The backend triggers `SolverRegistryService.slashSolver()` against the Soroban contract:
   - **Contract Call**: `slash(solverAddress, intentId)`
   - **Penalty**: Collateral is slashed from the solver's bond and transferred/burned according to protocol rules.
4. **WebSocket Alert**: An `intent_slashed` event is broadcast across the feed.

### Scoped Solver Credentials

Instead of handing out your full-trust SEP-10 session JWT to every piece of
automation, you can mint narrowly-scoped credentials (issue #443). Each
credential carries a fixed set of scopes chosen at creation/rotation time and
an optional IP allowlist.

| Scope | Grants |
|---|---|
| `solver:read` | Read the solver's own record and stats. |
| `intents:read` | Read intents visible to the solver. |
| `quote:respond` | Respond to RFQ quote requests. |
| `intents:accept` | Accept intents. |
| `intents:fill` | Fill intents. |
| `solver:update` | Update the solver's own mutable profile fields (§1a). |
| `solver:deregister` | Deregister the solver. |

`SCOPE_REQUIREMENTS` in `solver-scopes.ts` is the single source of truth for
which scope each operation requires. The profile-update and deregistration
endpoints accept **either** a SEP-10 session JWT (unchanged, full trust) **or**
a scoped credential carrying the matching scope — the scope path is an
additional, opt-in acceptance path.

> **Trust note:** a credential's scopes are fixed at creation/rotation time and
> cannot be narrowed in place. Granting `solver:deregister` to a long-lived
> automation credential is a meaningful trust decision: deregistration is
> irreversible for that registration epoch, so a leaked credential with this
> scope can take your solver offline permanently. Prefer short-lived
> credentials for anything holding `solver:deregister`.

#### Updating a credential's IP allowlist

You can tighten or loosen a credential's IP allowlist **without rotating the
secret**:

```
PATCH /api/v1/solvers/:address/credentials/:id/ip-allowlist
Authorization: Bearer <session JWT or scoped credential>
```

```json
{ "ipAllowlist": ["203.0.113.10", "198.51.100.0/24"] }
```

Send `null` (or an empty array) to clear the allowlist and allow any source IP.

- **Authentication**: identical to the other credential endpoints
  (`SolverJwtGuard` plus an ownership check against `:address`); a credential
  belonging to another solver's address is rejected with `403`/`404`.
- **Validation**: every entry is parsed with `parseAllowlistEntry` before
  anything is persisted. If *any* entry is invalid the whole request is
  rejected with the `describeAllowlistEntry` reason and **no partial write**
  occurs — the previous allowlist stays in effect.
- **Cache**: the update invalidates the in-process `activeCache` entry for the
  credential's prefix, so the guard enforces the new allowlist immediately
  rather than serving a stale entry for up to `CACHE_TTL_MS`.
- **Audit**: the change is recorded via `AdminAuditService`, the same way
  create/rotate/revoke are.
- **Out of scope**: `scopes` and `expiresAt` cannot be changed here — those
  remain rotation-only.

**Responses**: `200 OK` with the updated credential metadata (never the
secret); `400` for an invalid entry; `403`/`404` for a non-owned credential.

### Per-Chain Fill Windows

When a solver calls `POST /api/v1/intents/:id/accept`, the intent's `deadline` is reset to `now + <chain fill window>`. The fill window is **chain-specific** and shorter than the open-intent deadline, reflecting the realistic settlement time for each chain:

| Source chain | Fill window | Rationale |
|---|---|---|
| `stellar` | **120 s** (2 min) | ~5-second ledger time; solver has ample margin |
| `base` | **600 s** (10 min) | 2-second blocks; bridging latency dominates |
| `optimism` | **600 s** (10 min) | Same block cadence as Base |
| `arbitrum` | **600 s** (10 min) | Sub-second blocks but L1 batch delay applies |
| `ethereum` | **1800 s** (30 min) | 12-second slots + confirmation depth |
| `polygon` | **900 s** (15 min) | ~2-second blocks; moderate finality |
| `avalanche` | **600 s** (10 min) | Fast finality; bridge latency dominates |
| *(unknown)* | **600 s** | Default fallback |

> **Operator note:** Make sure your solver bot completes on-chain settlement and calls
> `POST /api/v1/intents/:id/fill` **before** the chain's fill window elapses.
> Exceeding the fill window triggers slashing regardless of the on-chain status
> of your settlement transaction. Plan for network latency and retry budgets
> within these windows, especially for Ethereum.

### Pending vs. Confirmed Slash

When the sweeper detects a missed deadline it immediately transitions the intent to `slashed` and records a **pending penalty** on the solver's record. The `fillsFailed` counter is incremented at this point.

The pending penalty is then submitted on-chain via `SolverRegistryService.slashSolver()`. Once the chain confirms the slash event (`solver_slashed` emitted by the solver-registry contract), the solver's `bondAmount` is reconciled downward to match the on-chain balance.

If the on-chain submission **never confirms** (network error, insufficient fee, contract rejection) the solver's `fillsFailed` counter may reflect a penalty that was never enforced on-chain. The backend will flag these as "unconfirmed" and operators should monitor for discrepancies between the `bondAmount` in `/api/v1/solvers/:addr/stats` and their on-chain balance. A future reconciliation pass (see on-chain settlement roadmap) will correct any divergence.
