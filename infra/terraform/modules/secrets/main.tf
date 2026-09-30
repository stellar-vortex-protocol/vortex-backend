# ─────────────────────────────────────────────────────────────────────────────
# module: secrets  (Google Secret Manager)
#
# Creates Secret Manager secrets for every credential the app needs.
# Values are NOT stored in Terraform state — operators populate them via
# `gcloud secrets versions add` or the CI secret-injection step.
#
# The app pod accesses secrets via Workload Identity + Secret Manager API
# (no environment variable injection; no static key files in images).
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
  required_version = ">= 1.6.0"
}

variable "project_id"     { type = string }
variable "environment"    { type = string }
variable "app_sa_email"   { type = string; description = "Workload Identity service account e-mail" }

locals {
  env = var.environment
}

# ── Secret definitions ────────────────────────────────────────────────────────

locals {
  secret_names = [
    "database-url",
    "redis-auth-string",
    "soroban-signing-key",
    "killswitch-operator-token",
    "public-stats-signing-key",
    "admin-api-keys",
    "auth-jwt-secret",
    "abuse-allowlist",
  ]
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(local.secret_names)
  project   = var.project_id
  secret_id = "vortex-${var.environment}-${each.key}"

  replication {
    user_managed {
      replicas {
        location = "us-central1"
      }
    }
  }

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

# ── IAM: workload identity SA gets secretAccessor on all secrets ──────────────

resource "google_secret_manager_secret_iam_member" "app_accessor" {
  for_each  = google_secret_manager_secret.secrets
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.app_sa_email}"
}

output "secret_ids" {
  value       = { for k, v in google_secret_manager_secret.secrets : k => v.secret_id }
  description = "Map of secret name → Secret Manager secret_id"
}
