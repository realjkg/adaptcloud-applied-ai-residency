# References

Vendor documentation for the stages. Behavior and menu paths change between versions, so check each page against the release you run.

## By stage

| Stage | Read first |
|---|---|
| 02 Management plane | Palo Alto: interface management profiles, administrative access best practices |
| 03 Zones and interfaces | Palo Alto: security policy overview |
| 04 Pool and monitor | F5: monitors settings reference |
| 05 TLS certificate | F5: client-side HTTPS with a CA-signed certificate; Cloudflare: Full (strict), Origin CA |
| 06 Virtual server | F5: SSL traffic management, client-side HTTPS |
| 07 Security policy | Palo Alto: components of a security policy rule, rule hierarchy |
| 08 Proxy and TLS mode | Cloudflare: encryption modes, Full (strict) |
| 09 WAF and origin lock | Cloudflare: Managed Ruleset, overrides, Authenticated Origin Pulls |
| 10 Branch tunnel | Meraki: IPsec VPN configuration settings |
| 11 Branch routing | Meraki: MX routing behavior |

## Palo Alto Networks

- [Security policy](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/policy/security-policy): rules are evaluated top to bottom, and the first match wins.
- [Components of a security policy rule](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/policy/security-policy/components-of-a-security-policy-rule)
- [Use interface management profiles to restrict access](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-networking-admin/configure-interfaces/use-interface-management-profiles-to-restrict-access): an interface with no profile denies management access. An empty permitted list allows any source.
- [Deploy administrative access best practices](https://docs.paloaltonetworks.com/best-practices/10-1/administrative-access-best-practices/administrative-access-best-practices/deploy-administrative-access-best-practices)
- [Manage the rule hierarchy (Panorama)](https://docs.paloaltonetworks.com/panorama/administration/manage-firewalls/manage-device-groups/manage-the-rule-hierarchy)

## F5 BIG-IP

These TechDocs pages cover older releases (11.5 to 11.6). The concepts hold, but confirm defaults and menu paths against your version.

- [Monitors settings reference](https://techdocs.f5.com/kb/en-us/products/big-ip_ltm/manuals/product/ltm-monitors-reference-11-5-0/3.html): an HTTP monitor's send string needs a trailing carriage return and line feed.
- [Managing client-side HTTPS traffic using a CA-signed certificate](https://techdocs.f5.com/kb/en-us/products/big-ip_ltm/manuals/product/ltm-implementations-11-5-1/12.html)
- [SSL traffic management](https://techdocs.f5.com/kb/en-us/products/big-ip_ltm/manuals/product/bigip-ssl-administration-11-5-0/3.html): the client SSL profile is attached to the virtual server, not the pool.

## Cloudflare

- [Encryption modes](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)
- [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/): the origin certificate must be unexpired, issued by a publicly trusted CA or Cloudflare Origin CA, and match the hostname.
- [Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- [Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/): a client-certificate check that stops requests that bypass Cloudflare. It does not work with Cloudflare Tunnel.
- [Cloudflare Managed Ruleset](https://developers.cloudflare.com/waf/managed-rules/reference/cloudflare-managed-ruleset/)
- [Override a managed ruleset](https://developers.cloudflare.com/ruleset-engine/managed-rulesets/override-managed-ruleset/): start in log mode, then move to block.

## Cisco Meraki

- [IPsec VPN configuration settings](https://documentation.meraki.com/SASE_and_SD-WAN/MX/Design_and_Configure/Configuration_Guides/Site-to-site_VPN/IPsec_VPN_Configuration_Settings): non-Meraki peers use pre-shared keys only, IKEv1 or IKEv2, and static routes.
- [MX routing behavior](https://documentation.meraki.com/SASE_and_SD-WAN/MX/Design_and_Configure/Configuration_Guides/Networks_and_Routing/MX_Routing_Behavior)
