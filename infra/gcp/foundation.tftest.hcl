mock_provider "google" {}

run "sandbox_plan" {
  command = plan

  variables {
    project_id               = "personal-sandbox-project"
    region                   = "us-central1"
    environment              = "sandbox"
    image_digest             = "us-central1-docker.pkg.dev/personal-sandbox-project/apps/applied-ai-residency@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    runtime_service_account  = "residency-runtime@personal-sandbox-project.iam.gserviceaccount.com"
    invoker_member           = "user:engineer@example.com"
    otel_collector_image     = "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    otel_config_secret       = "residency-otel-config"
    min_instances            = 1
    max_instances            = 2
    monthly_model_budget_usd = 100
  }

  assert {
    condition     = google_cloud_run_v2_service.service.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    error_message = "The Cloud Run sandbox must remain private."
  }

  assert {
    condition     = google_cloud_run_v2_service.service.template[0].scaling[0].min_instance_count == 1
    error_message = "The sandbox plan must remain right-sized."
  }
}
