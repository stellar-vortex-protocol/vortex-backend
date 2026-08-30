# API Rate Limits and Abuse Prevention Policy

This document details the rate limiting policies, abuse prevention mechanisms, error response formats, and client retry guidelines for API consumers of `vortex-backend` (including `vortex-frontend`, solver bots, and third-party integrations).

---

## Policy Overview

To guarantee backend stability, protect system resources against Denial-of-Service (DoS) attacks, and enforce fair usage, `vortex-backend` implements a multi-tiered rate limiting strategy using `@nestjs/throttler`.

Limits operate at two primary levels:
1. **Global IP-Level Rate Limit**: Protects all HTTP endpoints from general request flooding per IP address.
2. **Per-User Intent Creation Limit**: Protects the intent generation pipeline against spam creations per Stellar wallet address.

---

## Rate Limit Tiers & Rules

| Tier / Guard | Target Endpoint(s) | Tracker Key | Rate Limit Window | Max Requests | Exceeded Action |
|---|---|---|---|---|---|
| **Global IP Throttle** | All HTTP Endpoints (`/api/v1/*`, `/health`, `/docs`) | Remote Client IP address | 60 seconds | 100 requests | `HTTP 429 Too Many Requests` |
| **Per-User Intent Guard** | `POST /api/v1/intents` | `dto.user` (Stellar Address, lowercased)* | 60 seconds | 10 requests | `HTTP 429 Too Many Requests` |

*\*Note: If the `user` field is omitted from the request body, the Per-User Intent Guard falls back to tracking by remote IP.*

---

## 429 Error Response Format

When a client exceeds an active rate limit, `vortex-backend` immediately returns an **`HTTP 429 Too Many Requests`** status code.

### JSON Response Body
```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests"
}
```

### Response Headers
Every response (including 429 errors) includes standard rate limiting headers:

| Header Name | Type | Description |
|---|---|---|
| `Retry-After` | Integer | Time to wait (in seconds) before sending another request |
| `X-RateLimit-Limit` | Integer | Total request quota allowed within the current 60-second window |
| `X-RateLimit-Remaining` | Integer | Remaining request quota in the current window |
| `X-RateLimit-Reset` | Integer | Unix epoch timestamp (in seconds) when the rate limit counter resets |

---

## Client Integration & Best Practices

### 1. Frontends (`vortex-frontend`)
- **Intent Creation Throttling**: The UI should disable or throttle the "Create Intent" submission button for 60 seconds after a user submits 10 intents.
- **Handling 429 Responses**: Read the `Retry-After` header and display a friendly user notification (e.g., *"Rate limit exceeded. Please wait X seconds before trying again."*).

### 2. Solver Operators & Automated Bots
- **Prefer WebSocket Streaming over HTTP Polling**: Solver bots must consume the WebSocket intent feed (`ws://<backend-host>/ws`) with topic-based subscriptions (`{ type: "subscribe", chains: [...] }`) instead of continuously polling `GET /api/v1/intents`. WebSocket connections are not subject to HTTP rate limit counters.
- **Exponential Backoff with Jitter**: When submitting transactions or calling REST endpoints, implement exponential backoff upon receiving HTTP 429:
  $$\text{BackoffDelay} = \min(2^{\text{attempt}} \times 1000 + \text{jitter}, 30000) \text{ ms}$$

---

## Bypassing & Custom Limits

For high-throughput institutional solvers or internal services requiring custom rate limits, contact the network operator or configure environment variables in dedicated self-hosted instances.
