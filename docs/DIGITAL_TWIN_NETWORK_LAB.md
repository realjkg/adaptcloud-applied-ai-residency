# Digital twin network lab: branch-to-application path

A credential-free exercise in which you model a multi-vendor network path as a digital twin, prove its control properties with a deterministic checker, diagnose deliberate change-control faults, and write the evidence a network or platform review would ask for.

The twin spans four vendors that appear in most enterprise estates:

| Vendor | Role in the twin | What it contributes |
|---|---|---|
| Cisco Meraki | `branch-security-appliance` (MX) | Branch edge, Auto VPN tunnel to the data center |
| Cloudflare | `edge-waf-dns` | Public DNS, reverse proxy, WAF in front of the origin |
| Palo Alto Networks | `ngfw` and `management-plane` (PA-Series, Panorama) | Next-generation firewall policy, App-ID, central management |
| F5 BIG-IP | `adc-ltm` (Local Traffic Manager) | Virtual server, pool, health monitors, TLS termination |

A digital twin is a model you can change and test before you touch production. This lab's twin is a JSON description plus a checker. It is not a running network.

## Scope and boundaries

Same boundaries as `CLAUDE.md` and `SECURITY.md`.

- **No vendor access.** The checker calls no vendor API, opens no tenant, and reads no credential. Do not add one to this repository.
- **Synthetic addresses only.** Use RFC 5737 documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) and RFC 1918 private ranges. Do not paste a production address, hostname, certificate, or key into a twin, even for a test.
- **Model, not configuration.** The checker validates the shape and control rules of the model. It does not parse Palo Alto policy syntax, Meraki dashboard exports, Cloudflare zone settings, or BIG-IP configuration. It cannot prove runtime behavior, performance, failover, or license state.
- **Optional real appliances are out of scope for the default path.** If you hold a student-owned evaluation license for a virtual appliance, run it in your own account, keep it isolated from production data, and destroy it when you finish. Confirm current evaluation terms with each vendor first. Nothing in this lab requires one.

## Run the baseline

```bash
npm ci
npm run twin:check
```

Expected result: `"status": "ready_for_human_review"` with no findings and `counts` of 6 components and 2 flows. A ready result means the model satisfies the lab's rules. It is not approval to change any network.

## The reference twin

Source: `examples/labs/digital-twin.json`.

```
Internet ──HTTPS──▶ cf-edge-waf ──▶ pa-ngfw-dmz ──▶ f5-bigip-adc ──▶ app-web-pool
                    (Cloudflare)    (Palo Alto)     (F5 LTM, TLS     (10.30.0.11,
                                                     termination)     10.30.0.12)

Branch ──Auto VPN──▶ meraki-mx-branch ──▶ pa-ngfw-dmz ──▶ f5-bigip-adc ──▶ app-web-pool

Management zone: panorama-mgmt (10.99.0.5). Never on an internet-sourced path.
```

The Auto VPN hop is modeled as one step in the path. It is not a physical link, and the checker does not model tunnel state.

## What the checker enforces

Each rule returns a finding ID. A finding names the component or flow it concerns and never echoes a submitted value.

| Finding | Rule |
|---|---|
| `TWIN-SHAPE` | Input is a JSON object with well-formed components and flows. Malformed entries are reported by position. |
| `TWIN-SYNTHETIC` | The twin declares `synthetic: true`. |
| `TWIN-UNIQUE` | Component and flow identifiers are unique. |
| `TWIN-VENDOR` | Each vendor is on the lab allowlist. |
| `TWIN-ROLE` | Each required role appears exactly once, and each role is implemented by its correct vendor. |
| `TWIN-ADDR` | Each address uses an RFC 5737 or RFC 1918 range. |
| `TWIN-REF` | Every hop in a flow path names a declared component. |
| `TWIN-PATH` | Every flow crosses the NGFW, then F5 delivery, and ends at the application pool. Internet flows also start at the Cloudflare edge. |
| `TWIN-TLS` | An HTTPS flow names a TLS termination point that sits on its path, before the application pool. |
| `TWIN-MGMT` | No management interface is exposed, and no internet-sourced flow traverses the management zone. |
| `TWIN-SECRET` | No field with a credential-like name (password, secret, token, API key, private key) appears anywhere in the twin. |

## Exercise

### Phase 1: Read the baseline (about 30 minutes)

1. Run `npm run twin:check` and read the JSON.
2. For each flow, explain in one sentence why it passes `TWIN-PATH` and `TWIN-TLS`.
3. Explain why the Meraki branch flow still must cross the Palo Alto NGFW, even though the branch is a trusted site.

### Phase 2: Build your own copy (about 60 minutes)

1. Copy the reference file: `cp examples/labs/digital-twin.json my-twin.json`.
2. Add a third pool member, `10.30.0.13`, to `app-web-pool`. Re-run `npm run twin:check -- --input=my-twin.json`. It should still pass.
3. Try an address you should not be able to use, such as `8.8.8.8`, on any component. Confirm the finding. Then restore a documentation address.
4. Write down what the checker cannot tell you. Include at least: pool health-monitor behavior, Palo Alto rule ordering (first match wins), and whether the Cloudflare origin certificate is valid.

### Phase 3: Diagnose the deliberate faults (about 90 minutes)

List the catalog, then inject each fault one at a time:

```bash
npm run twin:check -- --list-faults
npm run twin:check -- --fault=F1-bypass-ngfw
```

A fault run exits `0` only if the expected finding fires. Work through all seven:

| Fault ID | Realistic change that causes it | Expected finding | Remediation |
|---|---|---|---|
| `F1-bypass-ngfw` | A "temporary" F5 virtual server rule forwards internet traffic around the firewall. | `TWIN-PATH` | Restore the NGFW hop. Require the security policy change to go through review. |
| `F2-exposed-management` | An engineer enables web management on the Panorama interface facing the internet. | `TWIN-MGMT` | Disable the exposed interface. Restrict management to the management zone and an allowlisted admin network. |
| `F3-management-on-internet-path` | A jump rule routes internet traffic through the Panorama host to reach a backend. | `TWIN-MGMT` | Remove the jump rule. Give administrators a separate, authenticated access path. |
| `F4-pasted-credential` | An engineer pastes an API key into an F5 record while documenting the model. | `TWIN-SECRET` | Rotate the key, since it has been exposed. Keep secrets in the platform's secret store, never in a model. |
| `F5-routable-address` | A production address is copied into the Cloudflare edge record. | `TWIN-ADDR` | Replace it with a documentation address. Treat the copy as a data-handling incident for the model. |
| `F6-mislabeled-vendor` | The NGFW record is labeled as F5 in the inventory. | `TWIN-ROLE` | Correct the inventory. A mislabeled device leads reviewers to check the wrong vendor's controls. |
| `F7-tls-off-path` | The HTTPS termination point is set to the Cloudflare edge, which the branch flow never traverses. | `TWIN-TLS` | Name the device that actually terminates TLS on that path, or add the missing hop. |

For each fault, write one sentence on the control it breaks and one on how you would detect it in a real environment (for example, a Palo Alto policy audit, a Cloudflare zone setting review, or a BIG-IP configuration diff).

### Phase 4: Change control (about 45 minutes)

Write a one-page change request for an addition of your choice, such as a second virtual server for a new synthetic API. Include:

- **Proposed change** in terms of the twin file, not device commands.
- **Pre-change check:** the `twin:check` result before your edit.
- **Post-change check:** the `twin:check` result after your edit, with the diff.
- **Rollback:** the exact file revision to restore.
- **Approver:** a human role. The checker sets `humanApprovalRequired: true` for every result, and you must not treat a ready result as approval.

### Phase 5: Evidence pack (about 30 minutes)

Produce a directory containing:

1. The baseline check JSON and one fault JSON for each of the seven faults.
2. The change request from Phase 4.
3. A short design note on single points of failure. The reference twin has one NGFW and one F5 instance. Name the failure domain, the blast radius, and the mitigation you would propose, such as an HA pair for each, and say what it would not solve.
4. A residual-risk list that states what the twin cannot prove.

### Phase 6: Architect extension (optional)

Argue, in an ADR-style note, where each vendor's control belongs in this path:

- Cloudflare Access or Zero Trust for administrative web applications, and whether it replaces, or sits in front of, the NGFW hop.
- Palo Alto GlobalProtect for remote users, and how its policy interacts with the branch path.
- Meraki Auto VPN failover, and how a second tunnel changes the path model.
- F5 Advanced WAF or APM as a second inspection layer, and the cost of running two inspection layers.

State your assumptions for each, and name what each option would make harder to audit.

## Well-Architected statement

The lab is credential-free, so its run cost is effectively zero. The table records what a real deployment of this path would need to state.

| Pillar | Lab position | Real-world obligation |
|---|---|---|
| Security | Default-deny path; management kept off the internet path; no secrets in the model. | Enforce the same rules in each vendor's policy, and audit them against the twin. |
| Resilience | One NGFW and one F5 instance, both single points of failure. | Document an HA design per device and test failover. |
| Reliability | Lab assumption: the checker is deterministic and reruns to the same result. | Track configuration drift between the twin and production. |
| Cost | No cloud or vendor spend in the default path. | Price licenses, subscriptions, and throughput tiers per vendor before a design review. |
| Sustainability | Local compute only: a few milliseconds of checking per run. | Retire unused virtual appliances rather than leaving them running. |
| Operations | Runbook: a failed check means the model is wrong or the change is unsafe, and the change stops until a human reviews it. | Keep the twin under version control, with one owner for each vendor's section. |

## Stop conditions

Stop the exercise and tell the instructor if any of these happen:

- a real address, hostname, certificate, credential, or customer data appears in a file you have written;
- a vendor page, tenant, or appliance asks for a payment method, a production login, or a credential that the exercise does not call for;
- the check passes but a rule you wrote would expose a management interface on the internet path;
- a virtual appliance you started is still running after the exercise.

## Completion rubric

- **Engineer:** runs the baseline and every fault, explains each finding, and writes a change request whose rollback is concrete.
- **Architect:** adds the Phase 5 single-point-of-failure analysis and the Phase 6 ADR, and names what the twin cannot prove.

Neither role should claim that a clean check means a network is secure, compliant, or ready for production. The check proves only the properties the lab models.

## Related references

- `docs/CLOUD_LAB.md`: the cloud foundation exercise that uses the same deterministic-first approach.
- `docs/MCP_CONNECTORS.md`: why vendor and cloud APIs stay out of this repository by default.
- `SECURITY.md`: trust boundaries, secret handling, and fail-closed behavior.

Vendor product names are trademarks of their owners and are used here only to identify roles in a training model.
