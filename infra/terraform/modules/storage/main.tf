# ─────────────────────────────────────────────────────────────────────────────
# module: storage  (GCS buckets)
#
# Provisions:
#   - Public stats dataset bucket (fine-grained ACL, public read)
#   - Terraform remote-state bucket (uniform ACL, versioning, lifecycle)
#   - Database backup bucket (private, 30-day lifecycle)
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
  required_version = ">= 1.6.0"
}

variable "project_id"  { type = string }
variable "region"      { type = string }
variable "environment" { type = string }

locals {
  prefix = "vortex-${var.environment}-${var.project_id}"
}

# ── Public stats dataset ──────────────────────────────────────────────────────

resource "google_storage_bucket" "public_stats" {
  project       = var.project_id
  name          = "${local.prefix}-public-stats"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = false   # allow fine-grained ACL for public read

  versioning { enabled = false }

  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 90 }
  }

  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  encryption { default_kms_key_name = "" }   # uses Google-managed keys for public data
}

resource "google_storage_bucket_iam_member" "public_stats_public_read" {
  bucket = google_storage_bucket.public_stats.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# ── Database backups ─────────────────────────────────────────────────────────

resource "google_storage_bucket" "db_backups" {
  project       = var.project_id
  name          = "${local.prefix}-db-backups"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  versioning { enabled = true }

  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 30 }
  }
}

output "public_stats_bucket" { value = google_storage_bucket.public_stats.name }
output "db_backups_bucket"   { value = google_storage_bucket.db_backups.name }
