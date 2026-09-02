# Security Policy

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
