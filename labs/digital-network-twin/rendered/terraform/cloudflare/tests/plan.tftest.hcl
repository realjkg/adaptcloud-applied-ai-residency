mock_provider "cloudflare" {}

run "plan_matches_twin" {
  command = plan

  variables {
    zone_id = "synthetic-zone-id"
  }

  assert {
    condition     = cloudflare_zone_setting.ssl.value == "strict"
    error_message = "SSL mode must match the twin."
  }

  assert {
    condition     = cloudflare_dns_record.app.proxied == true
    error_message = "The record proxy setting must match the twin."
  }

  assert {
    condition     = cloudflare_dns_record.app.content == "198.51.100.2"
    error_message = "The record must point at the planned origin."
  }
}
