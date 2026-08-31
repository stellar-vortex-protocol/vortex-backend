# Security Policy

## Supported Versions

The project currently supports the `main` branch only. Security patches and bug fixes are deployed to production as they are completed. Stable releases have not yet been established.

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please **do not open a public GitHub issue**. Instead, report it privately through GitHub's Security Advisory feature or by emailing security@vortex-protocol.dev.

### Private Reporting Channels

1. **GitHub Security Advisories** (Preferred)
   - Navigate to the repository's Security tab
   - Click "Report a vulnerability" to open a private advisory
   - This is the fastest and most secure way to notify us

2. **Email**
   - Send a detailed report to: security@vortex-protocol.dev
   - Please include:
     - A clear description of the vulnerability
     - Steps to reproduce (if applicable)
     - Potential impact and severity assessment
     - Any suggested fixes

### Response Timeline

- **Acknowledgment**: We will acknowledge receipt of your report within **5 business days**
- **Investigation**: We will investigate and provide an initial assessment within **10 business days**
- **Remediation**: Our goal is to have a patch or mitigation plan within **30 days** for critical issues
- **Disclosure**: We will coordinate with you on a responsible disclosure timeline

For active security issues with high severity, we may expedite this process.

## Security Scope

The following components are explicitly in scope for security research and vulnerability reports:

### High-Priority Security Areas

- **Signature & Authentication** (`src/common/stellar-signature.ts`, `src/soroban/signer.service.ts`)
  - Ed25519 signature verification on state-mutating endpoints
  - Signing key management and validation
  - Known tracking issues: #19, #20, #26

- **Fund-Moving Code** (`src/soroban/stellar-tx.service.ts`)
  - Transaction construction and submission logic
  - Settlement contract integration
  - Known tracking issues: #82–#97

- **Solver Registry & Authorization** (related to issues #82–#97)
  - Access control for solver operations
  - Bond management and verification

- **WebSocket & Real-Time Updates** (related to issue #96)
  - Authentication of WebSocket connections
  - Rate limiting and resource exhaustion protections

### Known Security Tracking Issues

Reporters are encouraged to review the existing issue tracker to avoid duplicate reports:

- **Authentication & Verification**: #19, #20, #26
- **Contract & Transaction Security**: #82–#97
- **Real-Time Communication**: #96

If your finding relates to one of these tracked issues, please specify which one in your report.

## Out of Scope

The following are not in scope for security vulnerability reports:

- Configuration errors on production deployments
- Missing security headers in default environments (our defaults follow best practices; issues with custom deployments should be reported to the operator)
- Performance or availability issues unrelated to intentional resource-exhaustion protections
- Third-party dependency vulnerabilities (please report directly to the maintainer of that package; we will update dependencies as patches are released)

## Security Best Practices

Contributors are expected to:

- Never commit secrets (API keys, signing keys, private credentials) to the repository
- Use `SOROBAN_SIGNING_KEY` from `.env` only (it is validated against Stellar secret seed format at startup in production)
- Review `.env.mainnet.example` and `.env.testnet.example` for secure configuration patterns
- Run `npm audit` locally before opening a PR
- Ensure Gitleaks secrets scanning passes in CI

## Related Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md) — Backend development conventions
- [CODE_OF_CONDUCT.md](https://github.com/vortex-protocol/.github/blob/main/CODE_OF_CONDUCT.md) — Community code of conduct
- `.github/workflows/ci.yml` — CI pipeline including secrets scanning (`secrets-scan`) and audit checks (`npm audit`)
- `commitlint.config.js` — Enforced commit message standards

## Maintenance

This security policy will be reviewed and updated as the project evolves. Critical security findings may trigger policy updates; changes will be reflected in future releases.
