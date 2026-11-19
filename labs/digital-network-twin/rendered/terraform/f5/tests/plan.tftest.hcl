mock_provider "bigip" {}

run "plan_matches_twin" {
  command = plan

  variables {
    bigip_address   = "192.0.2.10"
    bigip_username  = "synthetic"
    bigip_password  = "synthetic"
    certificate_pem = "synthetic"
    private_key_pem = "synthetic"
  }

  assert {
    condition     = bigip_ltm_virtual_server.app.destination == "10.20.0.100"
    error_message = "The virtual server must listen on the planned VIP."
  }

  assert {
    condition     = bigip_ltm_virtual_server.app.port == 443
    error_message = "The virtual server must listen on the planned port."
  }

  assert {
    condition     = bigip_ltm_virtual_server.app.source_address_translation == "automap"
    error_message = "SNAT must match the twin."
  }
}
