# ─────────────────────────────────────────────────────────────────────────────
# environments/staging — composes all modules into a staging environment.
#
# Remote state: GCS bucket with locking (default backend for GCS).
# Usage:
#   terraform init -backend-config=backend.hcl
#   terraform workspace select staging || terraform workspace new staging
#   terraform plan
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }

  # Remote state: replace <TF_STATE_BUCKET> with the GCS bucket created below
  # or bootstrapped manually before first apply.
  backend "gcs" {
    bucket = "vortex-tf-state"          # override via -backend-config
    prefix = "terraform/staging"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Variables ─────────────────────────────────────────────────────────────────

variable "project_id"        { type = string }
variable "region"            { type = string; default = "us-central1" }
variable "health_check_host" { type = string; default = "" }
variable "kms_key_id"        { type = string; default = "" }
variable "notification_channels" {
  type    = list(string)
  default = []
}

locals { environment = "staging" }

# ── Modules ───────────────────────────────────────────────────────────────────

module "network" {
  source      = "../../modules/network"
  project_id  = var.project_id
  region      = var.region
  environment = local.environment
}

module "k8s" {
  source               = "../../modules/k8s"
  project_id           = var.project_id
  region               = var.region
  environment          = local.environment
  network_self_link    = module.network.vpc_id
  subnet_self_link     = module.network.private_subnet_id
  pods_range_name      = module.network.pods_range_name
  services_range_name  = module.network.services_range_name
  vpc_cidr             = "10.0.0.0/16"
}

module "postgres" {
  source             = "../../modules/postgres"
  project_id         = var.project_id
  region             = var.region
  environment        = local.environment
  network_self_link  = module.network.vpc_id
  kms_key_id         = var.kms_key_id
}

module "redis" {
  source             = "../../modules/redis"
  project_id         = var.project_id
  region             = var.region
  environment        = local.environment
  network_self_link  = module.network.vpc_id
}

module "storage" {
  source      = "../../modules/storage"
  project_id  = var.project_id
  region      = var.region
  environment = local.environment
}

module "secrets" {
  source        = "../../modules/secrets"
  project_id    = var.project_id
  environment   = local.environment
  app_sa_email  = module.k8s.app_sa_email
}

module "observability" {
  source                = "../../modules/observability"
  project_id            = var.project_id
  environment           = local.environment
  health_check_host     = var.health_check_host
  notification_channels = var.notification_channels
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "cluster_name"       { value = module.k8s.cluster_name }
output "postgres_primary_ip" { value = module.postgres.primary_private_ip }
output "redis_host"         { value = module.redis.host }
output "public_stats_bucket" { value = module.storage.public_stats_bucket }
