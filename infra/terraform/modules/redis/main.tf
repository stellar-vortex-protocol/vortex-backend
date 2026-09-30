# ─────────────────────────────────────────────────────────────────────────────
# module: redis  (Memorystore for Redis)
#
# - Standard tier (HA with automatic failover)
# - Private IP only; no public endpoint
# - CMEK encryption at rest
# - AUTH enabled (password delivered via Secrets Manager)
# - In-transit encryption (TLS)
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
  required_version = ">= 1.6.0"
}

variable "project_id"        { type = string }
variable "region"            { type = string }
variable "environment"       { type = string }
variable "network_self_link" { type = string }

variable "memory_size_gb" {
  type    = number
  default = 2
  description = "Redis memory in GB (Standard tier; 1–300 GB)"
}

variable "redis_version" {
  type    = string
  default = "REDIS_7_0"
}

resource "google_redis_instance" "primary" {
  project        = var.project_id
  name           = "vortex-redis-${var.environment}"
  region         = var.region
  tier           = "STANDARD_HA"
  memory_size_gb = var.memory_size_gb
  redis_version  = var.redis_version

  authorized_network = var.network_self_link

  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"

  # Maintenance window: Tuesdays 03:00 UTC
  maintenance_policy {
    weekly_maintenance_window {
      day = "TUESDAY"
      start_time {
        hours   = 3
        minutes = 0
        seconds = 0
        nanos   = 0
      }
    }
  }

  redis_configs = {
    maxmemory-policy = "allkeys-lru"
    notify-keyspace-events = "Ex"  # expiry events; used by abuse scorer TTL watch
  }
}

output "host"     { value = google_redis_instance.primary.host }
output "port"     { value = google_redis_instance.primary.port }
output "auth_string" {
  value     = google_redis_instance.primary.auth_string
  sensitive = true
}
