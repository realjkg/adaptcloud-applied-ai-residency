# Rendered from the twin config by tools/render-iac.mjs. Plan-only: never apply from the lab.

resource "bigip_ltm_monitor" "app" {
  name     = "/Common/app-pool-monitor"
  parent   = "/Common/http"
  send     = "GET /health HTTP/1.1\r\nHost: app.lab.example\r\nConnection: close\r\n\r\n"
  receive  = "200"
  interval = 5
  timeout  = 16
}

resource "bigip_ltm_pool" "app" {
  name                = "/Common/app-pool"
  load_balancing_mode = "round-robin"
  monitors            = [bigip_ltm_monitor.app.name]
}

resource "bigip_ltm_pool_attachment" "member_1" {
  pool = bigip_ltm_pool.app.name
  node = "10.30.0.11:8080"
}

resource "bigip_ltm_pool_attachment" "member_2" {
  pool = bigip_ltm_pool.app.name
  node = "10.30.0.12:8080"
}

resource "bigip_ssl_certificate" "app" {
  name      = "app-cert.crt"
  content   = var.certificate_pem
  partition = "Common"
}

resource "bigip_ssl_key" "app" {
  name      = "app-cert.key"
  content   = var.private_key_pem
  partition = "Common"
}

# The twin requires "TLSv1.2" or later. Set the minimum through the profile's
# options for your BIG-IP version, then confirm it with the stage 06 verification.
resource "bigip_ltm_profile_client_ssl" "app" {
  name          = "/Common/app-clientssl"
  defaults_from = "/Common/clientssl"
  cert          = "/Common/app-cert.crt"
  key           = "/Common/app-cert.key"
}

resource "bigip_ltm_virtual_server" "app" {
  name                       = "/Common/app-vs"
  destination                = "10.20.0.100"
  port                       = 443
  ip_protocol                = "tcp"
  pool                       = bigip_ltm_pool.app.name
  client_profiles            = [bigip_ltm_profile_client_ssl.app.name]
  source_address_translation = "automap"
}
