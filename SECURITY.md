# Security Policy

## Verifying build artifacts (issue #467)

Every container image this repository publishes is signed **keylessly** with
[cosign](https://docs.sigstore.dev/cosign/signing/overview/) and carries two
[attestations](https://slsa.dev/spec/v1.0/): SLSA build provenance and a
CycloneDX SBOM. Nothing is ever signed with a stored key — the signing
credential is a short-lived GitHub OIDC token minted for the specific workflow
run, so there is no long-lived secret to exfiltrate.

**Images**

```
ghcr.io/stellar-vortex-protocol/vortex-backend
```

Tagged `main`'s commit SHA, `staging`, and every `v*` release tag. Always
consume a digest, never a tag — the digest is what the signature covers.

### What signing is trusted to mean

A signature on an image asserts all of the following, and `cosign verify`
checks each one:

| Check | Asserts |
|---|---|
| `certificate-oidc-issuer == https://token.actions.githubusercontent.com` | The key was issued by GitHub's OIDC provider to *this* workflow run, not copied from anywhere. |
| `certificate-identity` matches `^https://github.com/stellar-vortex-protocol/vortex-backend/(.github/workflows/cd\.yml@refs/heads/main\|refs/tags/v[0-9].*)$` | The signing workflow was `cd.yml`, running from `main` or from a release tag. A signature made from any other branch — including an attacker's branch in this repository — fails verification. |
| The subject digest matches what you are about to run | The signature is bound to these exact bytes. A different build cannot reuse it. |

`pull_request` events never receive `id-token: write`, `attestations: write` or
`packages: write` — those are granted only to the `build` job in
`.github/workflows/cd.yml`, which is skipped for pull requests. A fork pull
request therefore cannot mint a signature that verifies against this
repository's identity.

### Verify an image before you run it

```bash
IMAGE=ghcr.io/stellar-vortex-protocol/vortex-backend
DIGEST=sha256:...

# 1. the signature
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/stellar-vortex-protocol/vortex-backend/(.github/workflows/cd\.yml@refs/heads/main|refs/tags/v[0-9].*)$' \
  "$IMAGE@$DIGEST"

# 2. the SLSA provenance attestation
cosign verify-attestation \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '<same regexp>' \
  --type slsaprovenance \
  "$IMAGE@$DIGEST"

# 3. the CycloneDX SBOM attestation
cosign verify-attestation \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '<same regexp>' \
  --type 'https://cyclonedx.org/bom' \
  "$IMAGE@$DIGEST"
```

Or, for the attestations, via the GitHub CLI, which reads the GitHub
attestation store rather than the registry:

```bash
gh attestation verify "$IMAGE@$DIGEST" --repo stellar-vortex-protocol/vortex-backend
```

### Where verification happens in this repository

`.github/workflows/cd.yml` does not merely document the check, it *runs* it, on
a runner that shares no state with the signer:

- `verify` — re-verifies the signature and both attestations from a clean
  runner. `staging` and `production` both `needs` this job, so an unverifiable
  build cannot be deployed.
- `production` — re-runs `cosign verify` immediately before pulling, and pulls
  **by digest**.
- `verify` additionally downloads the generated SBOMs and asserts they are
  well-formed CycloneDX/SPDX documents that reference the exact digest being
  deployed, so a "verified" build cannot be paired with someone else's SBOM.

### Known gap: cluster admission control

The issue also asked for a `policy-controller` / Kyverno policy. That is **not
implemented** here, and the gap is worth stating plainly: the `cosign verify`
steps above protect the deploys this workflow performs, but they do not stop
someone with `kubectl apply` access from running an unsigned image directly.

The cluster-side policy is the piece that closes that, by rejecting unsigned
images at admission regardless of who is asking. Tracked as follow-up work; it
needs a cluster this repository does not own.

### SBOM locations

| Location | Format | Audience |
|---|---|---|
| Attached to the image as an OCI artifact | CycloneDX JSON | Automated scanners pulling the image. |
| Release assets on `v*` tags | CycloneDX JSON + SPDX JSON | Humans, and tooling that reads GitHub releases. |
| `sbom-<sha>` workflow artifact (90-day retention) | Both | Post-incident forensics after a 90-day-plus deploy. |

### Action pinning policy

Every `uses:` in `.github/workflows/*.yml` is pinned to a full 40-character
commit SHA, with the release it corresponds to recorded in a trailing comment
(`# v4.3.0`). A floating tag like `actions/checkout@v4` is mutable: whoever
controls the tag can change what runs in this repository's CI, with the
repository's own credentials and OIDC identity. Dependabot's `github-actions`
ecosystem keeps the pins current and will open a PR when a SHA needs bumping,
so pinning costs maintainability nothing.

One deliberate exception: the `formal` job's
`docker://tlaplus/tlaplus:latest` is a container image reference, not a GitHub
Action, so it is outside this policy. It is also the only unpinned executable in
CI and is a fair next target.

## Mandatory code-owner review on high-risk paths

The repository's branch protection rule for `main` has "Require review from
Code Owners" enabled, scoped via [CODEOWNERS](./CODEOWNERS) to:

- `src/soroban/` — on-chain signing/submission
- `src/common/stellar-signature.ts` — signature verification
- `prisma/schema.prisma` — data model
- `src/soroban/signer.service.ts` — key handling

PRs touching these paths cannot merge without sign-off from a qualified
reviewer, independent of whatever general review the PR already received.

### Rationale

This backlog documents a recurring class of bug that has slipped through
general review specifically in these paths:

- Signature-verification gaps: issues #82, #83, #96, #97
- Key-material handling: issue #91
- Spoofable trust boundaries: issue #20

The general CODEOWNERS mapping (issue #101) routes review requests, but is
advisory only without branch-protection enforcement. This policy makes review
on this highest-risk subset mandatory, not optional.

## Reporting a vulnerability

If you discover a security vulnerability, please report it privately to the
maintainers rather than opening a public issue.

## Stellar Intent Signatures (issue #462)

Accept, fill, and cancel requests use the v2 message format:

```
vortex:<network>:<action>:<intentId>:<nonce>:<expiresAt>:<payloadHash>
```

`network` is the configured Stellar network, `nonce` is a random single-use
value, `expiresAt` is a Unix timestamp no more than 15 minutes ahead, and
`payloadHash` is the SHA-256 hash of the action payload's canonical JSON. The
server verifies the signature and all request constraints before atomically
consuming `(signer, nonce)`. Reuse returns `409 NONCE_REUSED`; consumed nonce
rows expire after the request's expiry plus clock-skew tolerance.

Version 1 signatures omit the domain, expiry, and nonce and are rejected by
default. Set `ALLOW_LEGACY_STELLAR_SIGNATURES=true` only for the temporary
client migration window; `vortex_legacy_stellar_signatures_total` reports
accepted v1 requests by action so operators can determine when to disable the
flag. The flag must be removed after clients have migrated.

## EVM Intent Signatures (issue #463)

EVM create/cancel signatures use EIP-712 with domain name `Vortex`, version
`1`, the fixed chain ID for `srcChain`, and that chain's configured escrow as
`verifyingContract`. `CreateIntent` signs all source/destination token fields,
amounts, deadline, nonce, and expiry. `CancelIntent` signs the creator,
intent ID, nonce, and expiry. SDK helpers are exported from
`@vortex/solver-sdk`; EOA recovery rejects high-s signatures. If recovery does
not match, the configured chain RPC is queried for ERC-1271
`isValidSignature(bytes32,bytes)`. EVM RPC hosts must be explicitly listed in
`EVM_RPC_ALLOWLIST`; RPC errors fail closed. Create and cancel nonces share the
same persistent `(signer, nonce)` uniqueness constraint as Stellar actions.
Configure the matching `*_RPC_URL` and `*_ESCROW_ADDRESS` values for each EVM
source chain; the EIP-712 chain ID is fixed by `srcChain` and cannot be supplied
by the request.

## SSRF Protection

All outbound HTTP requests (RPC, Horizon, oracles, webhooks) are routed through `HttpEgressService` which enforces:

- **DNS rebinding protection**: Double DNS resolution to detect IP changes
- **Private IP blocking**: RFC1918 ranges, loopback, link-local, cloud metadata endpoints
- **IPv6 support**: Blocks unique local addresses (fc00::/7), link-local (fe80::/10)
- **Allowlist enforcement**: Per-purpose domain allowlists from config
- **Redirect validation**: Re-validates redirect targets against allowlist and IP checks
- **Response size limits**: Prevents memory exhaustion
- **Timeouts**: Prevents hanging connections

### Bypassing SSRF Protection

**DO NOT** use direct `fetch`, `axios`, or `node-fetch` imports. Always use `HttpEgressService`:

```typescript
import { HttpEgressService, EgressPurpose } from '@/common/http-egress';

// ✅ Correct
const egress = new HttpEgressService(config);
await egress.fetch(url, { purpose: EgressPurpose.RPC });

// ❌ Forbidden - will fail linting
import fetch from 'node-fetch';
await fetch(url);