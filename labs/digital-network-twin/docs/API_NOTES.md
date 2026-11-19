# Vendor API notes

What the official API documentation says about the calls the live adapters make, read on 2026-11-19. Each fact is from a page listed under its vendor. Anything the pages did not show is under "Not confirmed" and is still an assumption in the code. These are notes with links, not copies of the vendors' pages. Check each page again before relying on a value, because versions change.

To refresh: the pages are plain HTTPS. Download each URL into its own empty directory, extract the text, and compare. Meraki pages embed the OpenAPI operation as JSON, which is more reliable to parse than the rendered text.

## Cloudflare (DNS records)

Sources: [Create](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/), [List](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/), [Delete](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/).

| Fact | Used by |
|---|---|
| Auth is `Authorization: Bearer <token>`. List needs DNS Read or DNS Write, delete needs DNS Write. | `tools/live/cloudflare.mjs` |
| Create is `POST /zones/{zone_id}/dns_records`. Required: `name` (at most 255, Punycode), `ttl` (1 means automatic, otherwise 60 to 86400), `type`. Optional: `content` (IPv4 format for `A`), `comment`, `proxied`, `tags`. | create |
| `comment` and `tags` are free text and "have no effect on DNS responses". A tag looks like `owner:dns-team`. | ownership mark (comment) |
| The 200 create response has `success: true` and the record under `result`, including its `id`. | create check |
| List is `GET /zones/{zone_id}/dns_records`. `name` is an object with `contains`, `endswith`, `exact`, `startswith`, and name filters are case-insensitive. `comment`, `content`, `tag`, `type`, and `proxied` filter too. | read, delete |
| Results are paginated with `page` and `per_page`. `result_info` carries `count`, `page`, `per_page`, `total_count`, `total_pages`. | pagination guard |
| Delete is `DELETE /zones/{zone_id}/dns_records/{dns_record_id}`. The documented 200 response is `{"result": {"id": "..."}}` with **no `success` flag**. | delete check |

**Found by reading these pages, and fixed:** the adapter filtered with `?name=`, which is not the documented form, and required `success: true` on delete, which the documented response does not contain. On a real zone the second mistake would have deleted the record and then reported failure. The adapter now uses `name.exact`, filters the result again by exact name itself, stops if the result spans more than one page, and treats a delete as successful when the status is 200 and the response returns the deleted id.

Not confirmed: how an object filter is encoded in the query string (the page shows an object, the adapter uses `name.exact=`), the default page size, rate limits.

## F5 BIG-IP (iControl REST)

Sources: [pool](https://clouddocs.f5.com/api/icontrol-rest/APIRef_tm_ltm_pool.html), [pool members](https://clouddocs.f5.com/api/icontrol-rest/APIRef_tm_ltm_pool_members.html), [HTTP monitor](https://clouddocs.f5.com/api/icontrol-rest/APIRef_tm_ltm_monitor_http.html), [virtual server](https://clouddocs.f5.com/api/icontrol-rest/APIRef_tm_ltm_virtual.html), [client SSL profile](https://clouddocs.f5.com/api/icontrol-rest/APIRef_tm_ltm_profile_client-ssl.html), [home](https://clouddocs.f5.com/api/icontrol-rest/).

| Fact | Used by |
|---|---|
| Pool is `/mgmt/tm/ltm/pool`, with GET, PUT, PATCH, DELETE, and POST on a resource. Natural key is `name`, `partition`, `subPath`. | `tools/live/f5.mjs` |
| Pool has `description`, `loadBalancingMode` (default `round-robin`), `monitor` (a single monitor, several joined with "and", or a "min" rule), and `allowSnat` (default `yes`). | pool |
| Pool members live under `/mgmt/tm/ltm/pool/~resource id/members` and have `description`. A member is named `ip:port`. The home page example creates members that way. | member |
| The HTTP monitor is `/mgmt/tm/ltm/monitor/http`. It has `description`, `interval` (default 5), `timeout` (default 16), `send` (default `GET /`), `recv`, and inherits settings through `defaultsFrom`. | monitor |
| A virtual server has `description`, `destination` as `<virtual-address>:<port>`, `pool`, and `ipProtocol`. `profiles` is a subcollection. | virtual server |
| `snat` is deprecated. Source address translation is a property group with `type` (default `none`) and `pool`. | virtual server |
| On the client SSL profile, `cert`, `key`, and `chain` are deprecated in favor of `certKeyChain`. A TLS minimum is set through `tmOptions`. | not implemented |
| Examples use basic authentication over HTTPS. | auth |
| F5 notes the reference includes community-contributed content, and recommends AS3 and FAST for deployment automation. | caveat |

Not confirmed: the status and message returned when deleting an object that is still referenced (the adapter assumes 400 with "referenced" or "in use"), the `~Common~name` path encoding, how `send` strings with CR and LF are returned (the adapter accepts escaped or real), the exact `profiles` body shape at create time and the `profilesReference` read-back, and the camel-case JSON name `sourceAddressTranslation`. The pages describe the group in command-line style as `source-address-translation`.

Residue: adding a pool member creates a node, which these pages do not mention deleting. The adapter leaves it.

## Palo Alto Networks (PAN-OS REST API, 11.1 and later pages)

Sources: [resource methods and query parameters](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-panorama-api/get-started-with-the-pan-os-rest-api/methods-supported-rest-api), [create a security policy rule](https://docs.paloaltonetworks.com/pan-os/10-1/pan-os-panorama-api/get-started-with-the-pan-os-rest-api/create-security-policy-rule-rest-api), [work with objects](https://docs.paloaltonetworks.com/ngfw/api/pan-os-rest-api-use-cases/work-with-address-objects-rest-api), [configure a security zone](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-panorama-api/get-started-with-the-pan-os-rest-api/configure-a-security-zone-rest-api).

| Fact | Notes |
|---|---|
| Base is `/restapi/v11.0/<resource URI>`, for example `Policies/SecurityRules`, `Objects/Addresses`, `Network/Zones`. | |
| List is GET, create is POST, modify is PUT, delete is DELETE. Rename is POST `:rename`. Move is POST `:move`, for policies only, with `where` of `top`, `bottom`, `before`, or `after`, and `dst` for the last two. | Rule order is addressable. |
| Query parameters are `location` (`shared`, `vsys`, or on Panorama `device-group`), `vsys`, `name`. JSON is the default format. | |
| The body is `{"entry": [ {"@name": ..., "@location": ..., "@vsys": ..., ...} ]}`. `entry` is an array. | |
| Auth is the `X-PAN-KEY` header. | |
| Address objects and application objects carry `description`. | A mark is possible there. |
| A rule's `service` is a list of members such as `application-default`. A rule example sets `from`, `to`, `source`, `destination`, `application`, `service`, `category`, `action`. | A literal `tcp/443` needs a service object. |
| The REST method table has no commit. Commit appears in the XML API pages. | Commit is a separate call. |
| The rule page says to set up interfaces and zones first. | |

Not confirmed: a `description` or tag on security rules and zones (the examples do not show one), the status for a missing object and for a delete of a referenced object, and the REST version prefix for other PAN-OS releases.

## Cisco Meraki (Dashboard API v1.76.0)

Sources: [L3 firewall rules](https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-l-3-firewall-rules/), [third-party VPN peers](https://developer.cisco.com/meraki/api-v1/update-organization-appliance-vpn-third-party-vpn-peers/), [authorization](https://developer.cisco.com/meraki/api-v1/authorization/), [rate limit](https://developer.cisco.com/meraki/api-v1/rate-limit/), [supported resources](https://developer.cisco.com/meraki/api-v1/supported-resources/).

| Fact | Notes |
|---|---|
| Base is `https://api.meraki.com/api/v1`. Auth is `Authorization: Bearer <key>` or the `X-Cisco-Meraki-API-Key` header. | |
| Rate limit is 10 requests per second per organization, with 10 extra in the first second. | |
| `updateNetworkApplianceFirewallL3FirewallRules` takes `networkId` and a `rules` array described as "an ordered array of the firewall rules (not including the default rule)". A rule has `comment`, `policy`, `protocol`, `srcPort`, `srcCidr`, `destPort`, `destCidr`, `syslogEnabled`. Required: `policy`, `protocol`, `srcCidr`, `destCidr`. | The whole list is one call. `comment` could carry a mark. |
| `updateOrganizationApplianceVpnThirdPartyVPNPeers` takes `organizationId` and a `peers` array. Each peer has `peerId`, `name`, `publicIp`, `publicHostname`, `privateSubnets`, `ikeVersion`, `ipsecPolicies`, `networkTags`, `secret`, and more. Required: `name`, `privateSubnets`, `secret`. | The secret is sent in the body. |
| The peers page warns that this call "does not run the org-wide subnet-overlap validation" and that overlapping subnets "may be blocked from further edits in Dashboard". | |

Not confirmed: any ETag or revision mechanism for concurrent updates (none appeared), and explicit "replaces" wording. Replacement is inferred from the body being the complete list.
