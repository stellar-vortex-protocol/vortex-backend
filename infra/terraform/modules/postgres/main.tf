# ─────────────────────────────────────────────────────────────────────────────
# module: postgres  (Cloud SQL for PostgreSQL with read replica)
#
# - Primary instance: db-custom-4-15360, pg16, private IP only
# - One read replica in the same region for analytics / read-heavy stats queries
# - Automated backups + PITR enabled
# - Encrypted at rest with CMEK (Cloud KMS)
# - No public IP; access via Private Service Connect
# - Deletion protection on in production
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.5" }
  }
  required_version = ">= 1.6.0"
}

variable "project_id"        { type = string }
variable "region"            { type = string }
variable "environment"       { type = string }
variable "network_self_link" { type = string }
variable "kms_key_id"        { type = string; description = "Cloud KMS key for CMEK encryption" }

variable "tier" {
  type    = string
  default = "db-custom-2-7680"
  description = "Cloud SQL machine type (db-custom-vCPU-memMB)"
}

variable "db_name"   { type = string; default = "vortex" }
variable "db_user"   { type = string; default = "vortex" }

locals {
  instance_name = "vortex-pg-${var.environment}"
}

resource "random_password" "db" {
  length  = 32
  special = true
}

resource "google_sql_database_instance" "primary" {
  project          = var.project_id
  name             = local.instance_name
  region           = var.region
  database_version = "POSTGRES_16"

  encryption_key_name = var.kms_key_id

  settings {
    tier              = var.tier
    availability_type = "REGIONAL"    # HA (primary + standby)
    disk_autoresize   = true
    disk_size         = 50
    disk_type         = "PD_SSD"

    ip_configuration {
      ipv4_enabled    = false          # no public IP
      private_network = var.network_self_link
      require_ssl     = true
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }

    maintenance_window {
      day          = 7   # Sunday
      hour         = 3
      update_track = "stable"
    }

    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
    # TimescaleDB extension for analytics aggregates
    database_flags {
      name  = "cloudsql.enable_pg_cron"
      value = "on"
    }
  }

  deletion_protection = var.environment == "production"
}

resource "google_sql_database_instance" "replica" {
  project              = var.project_id
  name                 = "${local.instance_name}-replica"
  region               = var.region
  database_version     = "POSTGRES_16"
  master_instance_name = google_sql_database_instance.primary.name

  encryption_key_name = var.kms_key_id

  replica_configuration {
    failover_target = false
  }

  settings {
    tier              = var.tier
    availability_type = "ZONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_self_link
      require_ssl     = true
    }
  }

  deletion_protection = false
}

resource "google_sql_database" "db" {
  project  = var.project_id
  instance = google_sql_database_instance.primary.name
  name     = var.db_name
}

resource "google_sql_user" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.primary.name
  name     = var.db_user
  password = random_password.db.result
}

output "primary_connection_name" { value = google_sql_database_instance.primary.connection_name }
output "replica_connection_name" { value = google_sql_database_instance.replica.connection_name }
output "primary_private_ip"      { value = google_sql_database_instance.primary.private_ip_address }
output "db_user"                  { value = google_sql_user.app.name; sensitive = true }
output "db_password"              { value = random_password.db.result; sensitive = true }
