# As-built requirements claim

Requirement set `SYNTH-ASBUILT-001`, as of 2026-11-18. **Synthetic requirements and configuration.** They show the mechanics and are not a customer's build.

## What this report claims

Of 17 requirements, **10 are met** by machine check against the modeled configuration, **1 is not met**, and **4 cannot be answered** from the model. 1 is attested by a person and 1 still needs an attestation.

It speaks only for the configuration with the digests below. It does not say the real devices match that configuration, and it is not evidence about runtime behavior. A requirement marked "Cannot say" is neither a pass nor a failure, and the reason says what is missing. An attestation is a person's statement and is never counted as a machine check.

| | |
|---|---|
| Configuration digest | `ebf4d2aee0611f80c70847dd536bc32aa507818c271861643faf56d2f8723df8` |
| Requirements digest | `4256f821fa3c0bcbc1d5161ee2655b97773827c5531fe0c0ba606d6722f4dc8d` |
| Attestations digest | `3075ca8a474deb1358c5f9486a71f401bb0532543d9dc17df2d021aeeb8df608` |
| Vendors in the configuration | cloudflare, f5, meraki, paloalto |
| Vendors with a mapping | cloudflare, f5, meraki, paloalto |

## Traceability

| Requirement | Title | Source | Verdict | cisco-ios | cloudflare | f5 | meraki | paloalto |
|---|---|---|---|---|---|---|---|---|
| SYN-SEC-001 | Management access is limited to named admin networks and uses encrypted protocols | Network Security Standard v1, 4.1 | Met | - | - | - | - | ok |
| SYN-SEC-002 | Every firewall ends in an explicit deny-all rule | Network Security Standard v1, 4.2 | NOT MET | - | - | - | FAIL | ok |
| SYN-SEC-003 | No allow rule uses any as its source, destination, or service | Network Security Standard v1, 4.3 | Cannot say | - | - | - | ? | ok |
| SYN-SEC-004 | Every firewall rule writes a log entry | Network Security Standard v1, 4.4 | Cannot say | - | - | - | ? | ok |
| SYN-VPN-001 | Site-to-site tunnels use IKEv2 | Connectivity Design v2, 3.1 | Met | - | - | - | ok | ok |
| SYN-VPN-002 | Both ends of a tunnel agree on the IKE version | Connectivity Design v2, 3.2 | Met | - | - | - | ok | ok |
| SYN-VPN-003 | Tunnel pre-shared keys are held as secret-store references, never as literals | Connectivity Design v2, 3.4 | Met | - | - | - | ok | ok |
| SYN-TLS-001 | Every TLS endpoint enforces TLS 1.2 or later | Network Security Standard v1, 5.1 | Cannot say | - | ? | ok | - | - |
| SYN-TLS-002 | Load balancer virtual servers enforce TLS 1.2 or later | Network Security Standard v1, 5.1 | Met | - | - | ok | - | - |
| SYN-TLS-003 | The edge validates the origin certificate | Network Security Standard v1, 5.3 | Met | - | ok | - | - | - |
| SYN-CERT-001 | Certificates have at least 30 days remaining | Operations Standard v3, 2.2 | Met | - | - | ok | - | - |
| SYN-LB-001 | Every pool has at least two members | Application Delivery Design v1, 2.1 | Met | - | - | ok | - | - |
| SYN-LB-002 | Every pool has an HTTP or HTTPS health monitor | Application Delivery Design v1, 2.3 | Met | - | - | ok | - | - |
| SYN-EDGE-001 | The public application is proxied, the WAF enforces, and the origin accepts only the edge | Edge Design v1, 1.2 | Met | - | ok | - | - | - |
| SYN-DOC-001 | The as-built diagram has been reviewed and approved by the network lead | Handover Checklist, 7.1 | Attested | - | - | - | - | - |
| SYN-DOC-002 | A configuration backup was restored successfully in the last quarter | Operations Standard v3, 6.4 | Needs attestation | - | - | - | - | - |
| SYN-CORE-001 | Core switches accept management over SSH only | Network Security Standard v1, 4.1 | Cannot say | gap | - | - | - | - |

Vendor columns: ok means every record from that vendor passed, FAIL that one did not, ? that a record lacks a field the model does not carry, gap that the vendor is named but cannot be checked, and - that the vendor has nothing to say.

## Where the claim stops, and why

### SYN-SEC-002: NOT MET

Every firewall ends in an explicit deny-all rule. 1 of 2 records violate it.
- Violates: `meraki.firewall` (meraki): lastRuleIsDenyAll = false

### SYN-SEC-003: Cannot say

No allow rule uses any as its source, destination, or service. 1 record lack a field the model does not carry.
- Unknown: `meraki.firewall[0]` (meraki): source = (not in the model), destination = 10.20.0.100/32, service = tcp/443, action = allow

### SYN-SEC-004: Cannot say

Every firewall rule writes a log entry. 2 records lack a field the model does not carry.
- Unknown: `meraki.firewall[0]` (meraki): log = (not in the model)
- Unknown: `meraki.firewall[1]` (meraki): log = (not in the model)

### SYN-TLS-001: Cannot say

Every TLS endpoint enforces TLS 1.2 or later. 1 record lack a field the model does not carry.
- Unknown: `cloudflare.ssl` (cloudflare): minVersion = (not in the model)

### SYN-DOC-002: Needs attestation

A configuration backup was restored successfully in the last quarter. needs a human attestation: The restore test record and its date.

### SYN-CORE-001: Cannot say

Core switches accept management over SSH only. no mapping for cisco-ios.

## Evidence for requirements that are met

**SYN-SEC-001** Management access is limited to named admin networks and uses encrypted protocols
- `management` (paloalto): permittedSources = ["10.99.0.0/24"], protocols = ["https","ssh"]

**SYN-VPN-001** Site-to-site tunnels use IKEv2
- `paloalto.ipsec` (paloalto): ikeVersion = 2
- `meraki.nonMerakiPeer` (meraki): ikeVersion = 2

**SYN-VPN-002** Both ends of a tunnel agree on the IKE version
- `paloalto.ipsec` (paloalto): ikeVersion = 2
- `meraki.nonMerakiPeer` (meraki): ikeVersion = 2

**SYN-VPN-003** Tunnel pre-shared keys are held as secret-store references, never as literals
- `paloalto.ipsec` (paloalto): authentication = secret-reference
- `meraki.nonMerakiPeer` (meraki): authentication = secret-reference

**SYN-TLS-002** Load balancer virtual servers enforce TLS 1.2 or later
- `f5.clientSsl` (f5): minVersion = TLSv1.2

**SYN-TLS-003** The edge validates the origin certificate
- `cloudflare.ssl` (cloudflare): verifiesOrigin = true, role = edge

**SYN-CERT-001** Certificates have at least 30 days remaining
- `tls.certificate` (f5): daysRemaining = 224

**SYN-LB-001** Every pool has at least two members
- `f5.pool` (f5): memberCount = 2

**SYN-LB-002** Every pool has an HTTP or HTTPS health monitor
- `f5.pool` (f5): monitorType = http

**SYN-EDGE-001** The public application is proxied, the WAF enforces, and the origin accepts only the edge
- `cloudflare` (cloudflare): proxied = true, wafAction = block, originPulls = true

## Attested by a person

- **SYN-DOC-001** The as-built diagram has been reviewed and approved by the network lead. attested by Network lead (role) on 2026-11-10, reference SYNTH-REVIEW-0042, diagram v3. A human statement, not machine-checked.
