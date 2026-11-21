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

Added from the [training labs](https://clouddocs.f5.com/training/community/automation/html/class01/module1/lab1.html) (labs 1 to 6 of module 1) and the [API introduction](https://clouddocs.f5.com/api/):

| Fact | Notes |
|---|---|
| A resource URI is the collection URI plus `~<partition>~<name>`, for example `/mgmt/tm/net/self/~Common~Self-Internal`. Create is POST to the collection URI. Modify is PATCH on the resource URI. | Confirms the path form the adapter uses. |
| Basic auth is `Authorization: Basic base64(user:pass)`. The lab says it is trivially decoded, so use HTTPS with a certificate from a certificate authority. | The lab warns against the self-signed certificates it uses itself. |
| Token auth is preferred: POST credentials once to `/mgmt/shared/authn/login`, then send the token. | The adapter uses basic auth. A token would send the password once per run. |
| `/mgmt/toc` is a built-in resource browser on TMOS 11.6 and later. | The device documents its own shapes, so use it to settle the unconfirmed items below on a first lab run. |
| **Transactions**: POST `/mgmt/tm/transaction` returns a `transId`. Operations are queued by sending the `X-F5-REST-Coordination-Id` header with it. A PATCH that sets `state` submits it. The whole batch succeeds or none of it does, and it times out after 120 seconds by default. | This is the atomic apply the adapter does not use. See the design notes below. |
| F5's introduction page recommends AS3 and FAST for declarative deployment and lists iControl REST as the imperative interface. | |

Still not confirmed after these pages: the virtual server and profile request bodies (the labs keep them in a Postman collection that is not reachable here), and the status returned when deleting a referenced object.

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

Not confirmed: a `description` or tag on security rules and zones (the examples do not show one), the HTTP status for a missing object and for a delete of a referenced object, and the REST version prefix for other PAN-OS releases.

Added from the [REST error codes](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-panorama-api/get-started-with-the-pan-os-rest-api/pan-os-rest-api-error-codes), the [access page](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-panorama-api/get-started-with-the-pan-os-rest-api/access-the-rest-api), the [REST API landing page](https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-panorama-api/get-started-with-the-pan-os-rest-api), and [pan.dev](https://pan.dev/panos/docs/restapi/):

| Fact | Notes |
|---|---|
| The 11.1 firewall resource list includes `Objects/Services`, `Objects/ServiceGroups`, `Objects/Addresses`, `Objects/Tags`, `Objects/ExternalDynamicLists`, `Policies/SecurityRules`, `Policies/NATRules`, `Network/Zones`, `Network/EthernetInterfaces`, `Network/TunnelIntefaces` (spelled that way in the table), `Network/VirtualRouters`, `Network/IPSecTunnels`, `Network/IKEGatewayNetworkProfiles`, `Network/InterfaceManagementNetworkProfiles`. | Service objects are not an API gap. The change set simply does not define them. A published list such as the Cloudflare ranges maps to an external dynamic list. |
| The URL is `https://<IP or FQDN>/restapi/<PAN-OS version>/<resource URI>`. The resource URIs on Panorama are analogous. | |
| Error `code` values in the body: 3 bad request, 5 not found, 6 conflict because the entity already exists, 7 forbidden, 16 unauthorized, 9 failed precondition, 10 aborted because of a conflict (a typical cause is a concurrency issue), 12 not implemented. | The page lists no HTTP statuses, so map these codes, not statuses, to "absent" and "already exists". |
| The on-device reference is at `https://<IP>/restapi-doc` per the PAN-OS guide, and `https://HOSTNAME/restapi` per pan.dev. | They disagree. Check which one your appliance serves, because it is version-specific and authoritative. |
| pan.dev points to the official SDKs, `pan-os-python` and `pan-os-go`, and recommends reading how the XML API and REST API differ before choosing one. | Commit is the XML API's `type=commit`. |

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

Added from the [how-to](https://documentation.meraki.com/Platform_Management/Dashboard_Administration/Operate_and_Maintain/How-Tos/How_to_Use_the_Cisco_Meraki_Dashboard_API), the [schema page](https://developer.cisco.com/meraki/api-v1/schema/), the [introduction](https://developer.cisco.com/meraki/api-v1/), and the [early access overview](https://developer.cisco.com/meraki/api-v1/api-reference-early-access-overview/):

| Fact | Why it matters |
|---|---|
| **A missing or wrong API key returns 404, not 403**, "to prevent leaking the existence of resources". | An adapter that reads 404 as "not there" would treat a bad key as an empty tenant and go on to create. A Meraki adapter must prove the key works with an authenticated call before it interprets any 404. |
| **Redirects must be followed.** A 302 can occur on any call. A redirected non-GET returns 307 or 308, and "client applications must follow these redirects". The redirecting host takes no action, so retrying on the new host is safe. | The guarded HTTP client refuses every redirect. Meraki cannot work through it as it stands, and the redirect target is a shard host that cannot be listed exactly in advance. That needs an owner decision, not a quiet exception. |
| An API key does not expire, carries the permissions of the admin who made it, and **works for every organization that admin can access**. SAML and SSO admins cannot create keys. | The key cannot be limited to one lab organization. Use a dedicated admin account that can see only the lab organization, and pin the organization id in policy. |
| Regional base URLs differ: `api.meraki.cn`, `api.meraki.ca`, `api.meraki.in`, `api.gov-meraki.com`. The default is `api.meraki.com`. | The host allowlist must name the right one. |
| Rate limit is 10 calls per second per organization. Some claim endpoints allow 10 per 5 minutes per IP. A limit returns 429 with `Retry-After` in seconds. | A client must back off on 429. |
| PUT "updates a resource" and "does not create one". All fields should be specified, "because omitted fields have no changes made to their value". | Field-level semantics. The pages do not say how a list field such as `rules` or `peers` is merged, so treat it as replaced. |
| Identifiers are opaque strings. Do not parse them as numbers. | |

The schema page and the early access page are mostly navigation. The early access page says its APIs are for test environments "where breaking API changes are acceptable", so do not build on them.

## What each remaining adapter would need

These are design requirements the documentation implies. None is built.

**F5, a stronger apply.** Use a transaction so the monitor, pool, members, and virtual server are created together or not at all. That removes the partial-apply state and most of the rollback the adapter does today. It needs the queue header on each call, a submit step, and a state check, and it must finish inside the 120-second default timeout. Switching to token auth would also stop the password being sent on every request.

**Palo Alto, to become implementable.**
1. Add service objects to the change set, and an external dynamic list in place of the placeholder address object, so rules reference things that exist.
2. Decide the ownership mark. Address objects carry a description. A tag exists as a resource, and the pages read do not show whether rules and zones accept one.
3. Order rules with the documented `:move` call, and verify the order after writing.
4. Leave commit to a person. It is not in the REST method table.
5. Map the error `code` values, not HTTP statuses, to "absent" and "already exists", and check them against the appliance's own `/restapi-doc`.

**Meraki, to become implementable.**
1. Prove the API key works before interpreting any 404.
2. Decide how redirects are handled. This is the hard one, because it conflicts with the no-redirect and exact-host rules.
3. Use a dedicated admin account that can see only the lab organization, and pin the organization id in policy.
4. Read the whole list, merge this twin's entries, write it back, and read it again, accepting that no concurrency guard is documented. For VPN peers, resolve the secret from the secret store at call time, since the API requires it in the body.
5. Back off on 429 using `Retry-After`.
