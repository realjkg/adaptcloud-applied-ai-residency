variable "project_id" {
  description = "Existing GCP project owned by the student."
  type        = string
}

variable "region" {
  description = "Cloud Run region selected through a documented residency/carbon/latency decision."
  type        = string
}

variable "image_digest" {
  description = "Immutable Artifact Registry image reference in repository@sha256:digest form."
  type        = string
  validation {
    condition     = can(regex("^[^[:space:]]+@sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be an immutable @sha256 reference."
  }
}

variable "runtime_service_account" {
  description = "Existing least-privilege Cloud Run runtime service account email."
  type        = string
}

variable "invoker_member" {
  description = "IAM member allowed to invoke, for example group:engineers@example.com. Never use allUsers."
  type        = string
  validation {
    condition     = !contains(["allUsers", "allAuthenticatedUsers"], var.invoker_member)
    error_message = "Public invocation is prohibited."
  }
}

variable "name" {
  type    = string
  default = "applied-ai-residency"
}

variable "environment" {
  type    = string
  default = "sandbox"
  validation {
    condition     = contains(["sandbox", "qa", "staging", "production"], var.environment)
    error_message = "environment must be sandbox, qa, staging, or production."
  }
}

variable "min_instances" {
  type    = number
  default = 1
  validation {
    condition     = var.min_instances >= (var.environment == "sandbox" ? 1 : 2)
    error_message = "Sandbox needs at least one instance; QA, staging, and production need at least two."
  }
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "automatic_rollback" {
  description = "Set true only after the external promotion controller proves health/SLO-triggered revision rollback."
  type        = bool
  default     = false
}

variable "backup_restore_tested" {
  description = "Set true only after attaching a scenario-appropriate data service and recording a successful restore drill."
  type        = bool
  default     = false
}

variable "carbon_aware_region" {
  description = "Set true only after recording the carbon, residency, latency, and availability region decision."
  type        = bool
  default     = false
}

variable "otel_collector_image" {
  description = "Fork-owner-approved, digest-pinned OpenTelemetry collector image."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.otel_collector_image))
    error_message = "otel_collector_image must be digest pinned."
  }
}

variable "otel_config_secret" {
  description = "Existing Secret Manager secret containing the approved collector config as config.yaml."
  type        = string
}

variable "monthly_model_budget_usd" {
  type    = number
  default = 2500
}

variable "labels" {
  type    = map(string)
  default = {}
}
