# Rendered plan

Generated from `config/twin-config.json` by `npm run render:iac`. Do not edit by hand.

- `changeset.json`: ordered, provider-neutral operations for all four vendors.
- `terraform/cloudflare` and `terraform/f5`: Terraform for those two vendors, with a mock-provider plan test each.
- Palo Alto and Meraki appear in the change set only.

Plan-only. Run the tests with mock providers and do not apply. Provider schemas were not checked when this was generated, so run `terraform init` and `terraform validate` in an environment that can reach the provider registry before you rely on any resource or attribute name.
