variable "aws_region" {
  description = "AWS region selected through a documented residency/carbon/latency decision."
  type        = string
}

variable "image_digest" {
  description = "Immutable ECR image reference in repository_url@sha256:digest form."
  type        = string
  validation {
    condition     = can(regex("^[^[:space:]]+@sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be an immutable @sha256 reference."
  }
}

variable "private_subnet_ids" {
  description = "At least two existing private subnets owned by the student's cloud account."
  type        = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide at least two private subnets across availability zones."
  }
}

variable "service_security_group_ids" {
  description = "Existing least-privilege security groups; ingress must come only from the trusted gateway."
  type        = list(string)
  validation {
    condition     = length(var.service_security_group_ids) > 0
    error_message = "Provide at least one service security group."
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

variable "desired_count" {
  type    = number
  default = 1
  validation {
    condition     = var.desired_count >= (var.environment == "sandbox" ? 1 : 2)
    error_message = "Sandbox needs at least one task; QA, staging, and production need at least two."
  }
}

variable "max_count" {
  type    = number
  default = 10
  validation {
    condition     = var.max_count >= var.desired_count
    error_message = "max_count must be at least desired_count."
  }
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
  description = "Fork-owner-approved, digest-pinned AWS Distro for OpenTelemetry collector image."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.otel_collector_image))
    error_message = "otel_collector_image must be digest pinned."
  }
}

variable "monthly_model_budget_usd" {
  type    = number
  default = 2500
}

variable "tags" {
  type    = map(string)
  default = {}
}
