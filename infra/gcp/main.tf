locals {
  labels = merge({
    application  = var.name
    environment  = var.environment
    "managed-by" = "terraform"
    "data-class" = "synthetic-only"
  }, var.labels)

  runtime_environment = {
    APP_ENV                     = var.environment
    AUTH_MODE                   = "gateway"
    SECRET_SOURCE               = "managed"
    AUDIT_SINK                  = "managed-immutable"
    TELEMETRY_EXPORTER          = "otlp"
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
    OTEL_SERVICE_NAME           = var.name
    MIN_REPLICAS                = tostring(var.min_instances)
    MULTI_ZONE                  = "true"
    AUTOSCALING                 = "true"
    CARBON_AWARE_REGION         = tostring(var.carbon_aware_region)
    INFRASTRUCTURE_AS_CODE      = "true"
    AUTOMATIC_ROLLBACK          = tostring(var.automatic_rollback)
    BACKUP_RESTORE_TESTED       = tostring(var.backup_restore_tested)
    MONTHLY_MODEL_BUDGET_USD    = tostring(var.monthly_model_budget_usd)
  }
}

resource "google_cloud_run_v2_service" "service" {
  name                = "${var.name}-${var.environment}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = var.environment == "production"
  labels              = local.labels

  template {
    service_account = var.runtime_service_account
    timeout         = "30s"

    volumes {
      name = "otel-config"
      secret {
        secret = var.otel_config_secret
        items {
          version = "latest"
          path    = "config.yaml"
        }
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name       = "application"
      image      = var.image_digest
      depends_on = ["otel-collector"]

      ports {
        container_port = 3000
      }

      dynamic "env" {
        for_each = local.runtime_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      startup_probe {
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 6
        http_get {
          path = "/health/ready"
          port = 3000
        }
      }

      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/health/live"
          port = 3000
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }
    }

    containers {
      name  = "otel-collector"
      image = var.otel_collector_image
      args  = ["--config=/etc/otelcol-google/config.yaml"]

      startup_probe {
        period_seconds    = 10
        timeout_seconds   = 3
        failure_threshold = 6
        http_get {
          path = "/"
          port = 13133
        }
      }

      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/"
          port = 13133
        }
      }

      volume_mounts {
        name       = "otel-config"
        mount_path = "/etc/otelcol-google"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.max_instances >= var.min_instances
      error_message = "max_instances must be at least min_instances."
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = var.invoker_member
}
