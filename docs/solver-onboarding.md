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

### Reputation & Bond Reconciliation
A solver's active reputation score is continuously computed using completion rates and account age:
$$\text{ReputationScore} = \text{SuccessRate} \times e^{-\frac{\text{AgeInDays}}{180}}$$
where $\text{SuccessRate} = \frac{\text{fillsCompleted}}{\text{fillsCompleted} + \text{fillsFailed}}$.

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
  "txHash": "0xabc123...",
  "signature": "base64EncodedSignatureOverFillMessage=="
}
```
This transitions the intent state to `filled`.

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
