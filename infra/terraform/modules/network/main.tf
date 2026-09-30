# ─────────────────────────────────────────────────────────────────────────────
# module: network
#
# Creates a VPC with:
#   - One private subnet per zone (Kubernetes nodes, DB, Redis)
#   - One public subnet per zone (NAT gateway, load balancers)
#   - Cloud Router + NAT for outbound-only internet from private subnets
#   - Firewall rules: deny all ingress, allow internal, allow health-check CIDRs
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.6.0"
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region (e.g. us-central1)"
  type        = string
}

variable "environment" {
  description = "Environment name: staging | production"
  type        = string
}

variable "cidr_block" {
  description = "Primary IPv4 CIDR for the VPC subnet"
  type        = string
  default     = "10.0.0.0/16"
}

locals {
  name_prefix = "vortex-${var.environment}"
}

# ── VPC ──────────────────────────────────────────────────────────────────────

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false
  description             = "Vortex ${var.environment} VPC"
}

# ── Private subnet (nodes / DB / Redis) ──────────────────────────────────────

resource "google_compute_subnetwork" "private" {
  project       = var.project_id
  name          = "${local.name_prefix}-private"
  region        = var.region
  network       = google_compute_network.vpc.self_link
  ip_cidr_range = var.cidr_block

  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.1.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.2.0.0/20"
  }

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# ── Public subnet (LB / NAT) ──────────────────────────────────────────────────

resource "google_compute_subnetwork" "public" {
  project       = var.project_id
  name          = "${local.name_prefix}-public"
  region        = var.region
  network       = google_compute_network.vpc.self_link
  ip_cidr_range = "10.3.0.0/24"
}

# ── Cloud Router + NAT ────────────────────────────────────────────────────────

resource "google_compute_router" "router" {
  project = var.project_id
  name    = "${local.name_prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.self_link
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${local.name_prefix}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.private.self_link
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# ── Firewall: deny all ingress by default ────────────────────────────────────

resource "google_compute_firewall" "deny_all_ingress" {
  project   = var.project_id
  name      = "${local.name_prefix}-deny-all-ingress"
  network   = google_compute_network.vpc.self_link
  priority  = 65534
  direction = "INGRESS"

  deny { protocol = "all" }

  source_ranges = ["0.0.0.0/0"]
}

# ── Firewall: allow internal traffic ────────────────────────────────────────

resource "google_compute_firewall" "allow_internal" {
  project   = var.project_id
  name      = "${local.name_prefix}-allow-internal"
  network   = google_compute_network.vpc.self_link
  priority  = 1000
  direction = "INGRESS"

  allow { protocol = "tcp" }
  allow { protocol = "udp" }
  allow { protocol = "icmp" }

  source_ranges = [var.cidr_block, "10.1.0.0/16", "10.2.0.0/20"]
}

# ── Firewall: GCP health-check source ranges ──────────────────────────────────

resource "google_compute_firewall" "allow_health_checks" {
  project   = var.project_id
  name      = "${local.name_prefix}-allow-health-checks"
  network   = google_compute_network.vpc.self_link
  priority  = 900
  direction = "INGRESS"

  allow { protocol = "tcp" }

  # GCP health-checker CIDRs (documented at cloud.google.com/load-balancing/docs/health-checks)
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "vpc_id" {
  value       = google_compute_network.vpc.id
  description = "VPC self-link"
}

output "private_subnet_id" {
  value       = google_compute_subnetwork.private.id
  description = "Private subnet self-link"
}

output "private_subnet_name" {
  value       = google_compute_subnetwork.private.name
  description = "Private subnet name (used by GKE node-pool config)"
}

output "pods_range_name" {
  value       = "pods"
  description = "Secondary range name for GKE pods"
}

output "services_range_name" {
  value       = "services"
  description = "Secondary range name for GKE services"
}
