# ─────────────────────────────────────────────────────────────────────────────
# module: observability
#
# Provisions:
#   - Google Cloud Monitoring alert policies for SLO breaches
#   - Log-based metrics for abuse-detector actions and intent funnel
#   - OTLP trace export to Cloud Trace (complementary to Tempo in docker-compose)
#   - Uptime checks on the /health endpoint
#
# For the full self-hosted Prometheus/Grafana/Loki/Tempo stack, see
# docker-compose.yml (observability profile) — that stack is deployed via
# Helm on the GKE cluster and is out of scope for Terraform.
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
  required_version = ">= 1.6.0"
}

variable "project_id"       { type = string }
variable "environment"      { type = string }
variable "notification_channels" {
  type        = list(string)
  default     = []
  description = "Notification channel resource names for alerts"
}
variable "health_check_host" {
  type        = string
  description = "Hostname of the /health endpoint to monitor"
}

# ── Log-based metric: abuse-detector blocks ──────────────────────────────────

resource "google_logging_metric" "abuse_blocks" {
  project = var.project_id
  name    = "vortex_abuse_blocks_${var.environment}"
  filter  = "resource.type=\"k8s_container\" jsonPayload.action=\"block\" jsonPayload.service=\"vortex-backend\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "clientIp"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "clientIp" = "EXTRACT(jsonPayload.clientIp)"
  }
}

# ── Log-based metric: intent funnel transitions ───────────────────────────────

resource "google_logging_metric" "intent_transitions" {
  project = var.project_id
  name    = "vortex_intent_transitions_${var.environment}"
  filter  = "resource.type=\"k8s_container\" jsonPayload.service=\"vortex-backend\" jsonPayload.transition!=\"\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "transition"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "transition" = "EXTRACT(jsonPayload.transition)"
  }
}

# ── Uptime check: /health/ready ───────────────────────────────────────────────

resource "google_monitoring_uptime_check_config" "health_ready" {
  project      = var.project_id
  display_name = "Vortex ${var.environment} /health/ready"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/health/ready"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.health_check_host
    }
  }
}

# ── Alert: uptime failure ─────────────────────────────────────────────────────

resource "google_monitoring_alert_policy" "uptime_failure" {
  project      = var.project_id
  display_name = "Vortex ${var.environment} uptime failure"
  combiner     = "OR"

  conditions {
    display_name = "/health/ready returned non-2xx"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\""
      duration        = "120s"
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields    = ["resource.labels.host"]
      }
    }
  }

  notification_channels = var.notification_channels
  severity              = "CRITICAL"
}

# ── Alert: abuse block rate spike ────────────────────────────────────────────

resource "google_monitoring_alert_policy" "abuse_spike" {
  project      = var.project_id
  display_name = "Vortex ${var.environment} abuse block rate spike"
  combiner     = "OR"

  conditions {
    display_name = "Abuse blocks > 50/min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/vortex_abuse_blocks_${var.environment}\""
      duration        = "60s"
      comparison      = "COMPARISON_GT"
      threshold_value = 50
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = var.notification_channels
  severity              = "WARNING"
}

output "uptime_check_id" { value = google_monitoring_uptime_check_config.health_ready.uptime_check_id }
