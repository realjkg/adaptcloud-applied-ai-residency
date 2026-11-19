# Rendered from the twin config by tools/render-iac.mjs. Plan-only: never apply from the lab.

resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = "app.lab.example"
  type    = "A"
  content = "198.51.100.2"
  ttl     = 1
  proxied = true
}

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = "strict"
}

# Cloudflare Managed Ruleset, with the twin's action applied as a ruleset-level override.
resource "cloudflare_ruleset" "waf_managed" {
  zone_id = var.zone_id
  name    = "Managed WAF"
  kind    = "zone"
  phase   = "http_request_firewall_managed"

  rules = [{
    action      = "execute"
    description = "Execute the Cloudflare Managed Ruleset"
    expression  = "true"
    enabled     = true

    action_parameters = {
      id        = "efb7b8c949ac4650a09736fc376e9aee"
      overrides = { action = "block" }
    }
  }]
}

# Authenticated Origin Pulls is not rendered: the resource differs between provider versions.
# Enable it for "app.lab.example" and pair it with the origin certificate check in stage 09.
