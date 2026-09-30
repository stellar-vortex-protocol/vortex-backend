# ─────────────────────────────────────────────────────────────────────────────
# module: k8s  (GKE Autopilot)
#
# Provisions a GKE Autopilot cluster with:
#   - Workload Identity (no static cloud keys in pods)
#   - Private nodes (no public IPs)
#   - Master authorized networks limited to the VPC CIDR
#   - Binary Authorization enabled
#   - Shielded nodes
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
  required_version = ">= 1.6.0"
}

variable "project_id"          { type = string }
variable "region"              { type = string }
variable "environment"         { type = string }
variable "network_self_link"   { type = string }
variable "subnet_self_link"    { type = string }
variable "pods_range_name"     { type = string }
variable "services_range_name" { type = string }
variable "master_cidr"         { type = string; default = "172.16.0.0/28" }
variable "vpc_cidr"            { type = string }

locals {
  cluster_name = "vortex-${var.environment}"
}

resource "google_container_cluster" "primary" {
  project  = var.project_id
  name     = local.cluster_name
  location = var.region

  enable_autopilot = true

  network    = var.network_self_link
  subnetwork = var.subnet_self_link

  ip_allocation_policy {
    cluster_secondary_range_name  = var.pods_range_name
    services_secondary_range_name = var.services_range_name
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.master_cidr
  }

  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = var.vpc_cidr
      display_name = "vpc-internal"
    }
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  binary_authorization {
    evaluation_mode = "PROJECT_SINGLETON_POLICY_ENFORCE"
  }

  release_channel {
    channel = "REGULAR"
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus { enabled = true }
  }

  # Prevent accidental cluster deletion
  deletion_protection = var.environment == "production"
}

# ── Workload Identity service account for the app ────────────────────────────

resource "google_service_account" "app" {
  project      = var.project_id
  account_id   = "vortex-app-${var.environment}"
  display_name = "Vortex app workload identity (${var.environment})"
}

resource "google_service_account_iam_binding" "workload_identity" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[vortex/vortex-backend]",
  ]
}

output "cluster_name"   { value = google_container_cluster.primary.name }
output "cluster_endpoint" { value = google_container_cluster.primary.endpoint }
output "app_sa_email"   { value = google_service_account.app.email }
