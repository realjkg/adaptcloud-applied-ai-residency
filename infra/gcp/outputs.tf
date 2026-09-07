output "service_uri" {
  value     = google_cloud_run_v2_service.service.uri
  sensitive = true
}

output "service_name" {
  value = google_cloud_run_v2_service.service.name
}

output "operator_next_step" {
  value = "Connect Cloud Run to the platform-owned authenticating load balancer; direct public invocation remains disabled."
}
