# ADR 0003 — Terraform Staging Infrastructure (GCP)

**Status:** Accepted  
**Date:** 2026-09-29  
**Authors:** Platform team  

---

## Context

There was no reproducible environment definition. Staging diverged from production, new maintainers could not stand up infrastructure without tribal knowledge, and the on-chain cutover rehearsal (see `docs/runbooks/onchain-cutover.md`) required a faithful staging environment to be meaningful.

We needed a choice of IaC tool and cloud provider that:

1. Supports managed Kubernetes, Postgres with replica, Redis, object storage, secrets manager, and an observability stack.
2. Enforces least-privilege IAM with workload identity for pods (no static cloud keys checked in or passed via env).
3. Keeps secrets out of state files (encryption at rest everywhere).
4. Has first-class CI tooling (fmt/validate, lint, static security scanning, cost estimation).
5. Can be operated by the existing team without a dedicated platform engineer.

---

## Decision

### IaC tool: **Terraform** (HashiCorp, MPL-2.0)

Alternatives considered:

| Tool | Rejected reason |
|---|---|
| Pulumi | Requires per-language SDK knowledge; team is already fluent in HCL. |
| AWS CDK | AWS-only; doesn't fit our GCP deployment target. |
| Helm-only | Covers Kubernetes workloads only; not a full infra tool. |

Terraform was chosen because:
- The team already uses HCL for existing config fragments.
- `tflint`, `checkov`/`tfsec`, and Infracost all have first-class GitHub Actions integrations.
- Remote state in GCS with native locking satisfies the locking requirement without an extra DynamoDB table (as AWS S3 backend would need).

### Cloud provider: **Google Cloud Platform (GCP)**

Alternatives considered:

| Provider | Rejected reason |
|---|---|
| AWS | EKS node-group management is heavier than GKE Autopilot; RDS lacks TimescaleDB native support. |
| Azure | Team has no existing GCP ↔ Azure migration path; AKS Managed Identity is comparable but less mature than Workload Identity Federation. |

GCP was chosen because:
- **GKE Autopilot** removes node-pool management entirely; our Kubernetes workloads are already containerised and fit the Autopilot resource model.
- **Cloud SQL** supports PostgreSQL 16 + TimescaleDB extension (required by `src/analytics/`) with CMEK and PITR out of the box.
- **Memorystore** Redis STANDARD_HA tier provides automatic failover, AUTH, and in-transit TLS matching our security requirements.
- **Workload Identity Federation** maps GKE service accounts to GCP IAM roles with no static key files — satisfying the "no static cloud keys" constraint.
- **Secret Manager** keeps secrets out of Terraform state; values are never written to `.tfstate`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  GCP project: vortex-staging                                │
│                                                             │
│  VPC (module/network)                                       │
│  ├── Private subnet: GKE nodes, Cloud SQL, Memorystore      │
│  └── Public subnet: Load balancer, NAT gateway              │
│                                                             │
│  GKE Autopilot (module/k8s)                                 │
│  ├── Workload Identity → app SA                             │
│  └── Binary Authorization                                   │
│                                                             │
│  Cloud SQL PG16 HA + read replica (module/postgres)         │
│  Memorystore Redis STANDARD_HA (module/redis)               │
│  GCS buckets: public-stats, db-backups (module/storage)     │
│  Secret Manager (module/secrets)                            │
│  Cloud Monitoring + Uptime checks (module/observability)    │
└─────────────────────────────────────────────────────────────┘
```

**Workload Identity flow:**
```
GKE Pod (k8s SA: vortex/vortex-backend)
  → IAM binding (workloadIdentityUser)
  → GCP SA: vortex-app-staging@<project>.iam.gserviceaccount.com
  → roles/secretmanager.secretAccessor
  → Secret Manager (credentials fetched at runtime, not baked into images)
```

---

## Module structure

```
infra/terraform/
├── modules/
│   ├── network/        # VPC, subnets, NAT, firewall
│   ├── k8s/            # GKE Autopilot, workload identity SA
│   ├── postgres/       # Cloud SQL PG16 + replica + CMEK
│   ├── redis/          # Memorystore STANDARD_HA
│   ├── storage/        # GCS buckets
│   ├── secrets/        # Secret Manager secrets + IAM
│   └── observability/  # Log metrics, uptime checks, alert policies
└── environments/
    └── staging/        # Composes all modules; remote-state backend
```

Each module is independently versioned and can be upgraded separately.

---

## Remote state

State is stored in a GCS bucket (`vortex-tf-state`) with object versioning and uniform ACL. GCS provides native state locking via the `x-goog-if-generation-match` header — no external lock table is needed.

Environments are isolated by GCS prefix (`terraform/staging`, `terraform/production`), not Terraform workspaces, to avoid the footgun of accidentally applying the wrong workspace.

---

## Security

| Constraint | Implementation |
|---|---|
| No secrets in state files | `sensitive = true` on all secret outputs; Secret Manager values never written to state |
| Encryption at rest | CMEK (Cloud KMS) for Cloud SQL and GCS backup bucket |
| No static cloud keys | Workload Identity Federation for CI; Workload Identity for pods |
| Least-privilege IAM | App SA gets only `secretmanager.secretAccessor`; CI SA gets `roles/editor` scoped to staging project |
| Private endpoints | Cloud SQL and Memorystore are private-IP only; GKE nodes have no public IPs |

---

## CI pipeline

See `.github/workflows/infra.yml`:

1. `terraform fmt -check -recursive` — enforces canonical formatting
2. `terraform validate` — structural correctness
3. `tflint` — GCP provider rule violations and deprecated syntax
4. `checkov` (HIGH/CRITICAL only) — CIS Benchmark misconfigurations; results uploaded as SARIF
5. `terraform plan` — plan output posted as a PR comment
6. `infracost diff` — cost delta posted as a PR comment

**No production apply automation.** Applies to staging are performed manually by a team member with the appropriate GCP IAM role.

---

## Consequences

- Staging can be torn down and recreated from scratch by any team member in ~20 minutes.
- On-chain cutover rehearsal has a faithful environment to target.
- Adding a new environment (e.g. `environments/canary`) requires duplicating the staging directory and changing `environment = "canary"`.
- The GCP provider version is pinned to `~> 5.0`; upgrades require a separate PR.
- Out of scope: production apply automation, multi-region DR, blue/green cluster upgrades.
