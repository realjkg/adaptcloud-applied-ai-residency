# Claiming against customer as-built requirements

The lab can check a customer's as-built requirements against the twin and say exactly what it can and cannot claim, across vendors. You write the requirements once, in the customer's own ids and wording. Each vendor's configuration is mapped into shared facts, so the same requirement is checked wherever the data exists and reported honestly where it does not.

```bash
npm run asbuilt                      # the synthetic example: 17 requirements, 4 vendors
npm run asbuilt -- --json            # the same, as data
npm run asbuilt -- --fail-on=not_met # exit 1 if anything is not met
```

The committed output is `docs/ASBUILT_REPORT.md`. **The example is synthetic.**

## The five verdicts

Each requirement gets exactly one.

- **Met.** Machine-checked against the modeled configuration. The report lists the evidence: every record considered, the exact config path it came from, and the values compared.
- **Not met.** At least one record violates it, and the report names the record.
- **Cannot say.** The model cannot answer it, either way. The reason says what is missing: a vendor with no mapping, a section absent from the config, or a field the model does not carry. This is not a pass.
- **Attested.** A named role attested on a date with a reference. It is a person's statement, labeled as one, and is never counted as a machine check.
- **Needs attestation.** A manual requirement with no current attestation.

## Rules that keep a claim exact

1. **Unknown is never a pass.** A field the model does not carry makes a record unknown. A requirement is met only when every record it considered passed.
2. **A failure outranks an unknown.** If one record fails, the requirement is not met, whatever else is unknown.
3. **An attestation cannot override a machine check.** It may attach only to a manual requirement, and it can expire.
4. **A typo cannot weaken a requirement.** Operators and keys are a closed set. An unrecognized one is an error, and the claim stops instead of running without it.
5. **It needs something to check.** With no matching record a requirement is not met, unless the author sets `minimum` to 0.
6. **The claim is bound to what it was made from.** The report carries digests of the configuration, the requirements, and the attestations. Change any of them and the digest changes.
7. **It speaks only for the modeled configuration.** It does not say the real devices match, and it is not evidence about runtime behavior.

## Writing a requirement

```json
{
  "id": "SYN-SEC-003",
  "title": "No allow rule uses any as its source, destination, or service",
  "source": "Network Security Standard v1, 4.3",
  "kind": "automated",
  "scope": { "vendors": ["paloalto", "meraki"] },
  "fact": "firewallRules",
  "where":  [{ "field": "action", "op": "eq", "value": "allow" }],
  "assert": [{ "field": "source", "op": "notIn", "value": ["any"] }]
}
```

- `id`, `title`, and `source` are the customer's. Keep their ids and document references so the report traces back to their documents.
- `kind` is `automated` or `manual`. A manual requirement has no `fact` and may say what evidence an attestation must show.
- `scope.vendors` limits a requirement to some vendors. Leave it out to apply it to every vendor that supplies the fact. A vendor named in scope but missing from the config, or with no mapping, is a gap, and the requirement cannot be met until it is covered.
- `fact` names the shared fact to check. `where` selects the records, and every condition must hold. `assert` is what each selected record must satisfy, and every condition must hold.
- `agree: { "field": "ikeVersion" }` replaces `assert` when the question is whether records from different vendors agree, such as both ends of a tunnel. It needs at least two records.
- `minimum` is how many records must match. It defaults to 1.

Operators: `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `exists`, `notExists`, `nonEmpty`, `lacksAny`, `containsAll`, `startsWith`, `endsWith`. There is no pattern matching, because a pattern from a requirements file could be made to hang the checker.

## The facts each vendor supplies

| Fact | Supplied by | Fields |
|---|---|---|
| `managementAccess` | paloalto | permittedSources, protocols |
| `firewallRules` | paloalto, meraki | action, destination, service, position. Palo Alto also supplies name, source, log, fromZone, toZone. Meraki does not carry a source or a log flag, so those are unknown for Meraki. |
| `defaultDeny` | paloalto, meraki | lastRuleAction, lastRuleIsDenyAll |
| `vpnTunnels` | paloalto, meraki | role, ikeVersion, peer, authentication (secret-reference, literal, or unknown, never the value). Meraki also supplies remoteNetworks and localNetworks. |
| `loadBalancing` | f5 | pool, memberCount, monitorType, method |
| `tlsEndpoints` | f5, cloudflare | role. F5 supplies minVersion. Cloudflare supplies mode and verifiesOrigin, and carries no minimum TLS version. |
| `certificates` | f5 | subject, issuer, notAfter, chainValidated, daysRemaining |
| `edgeExposure` | cloudflare | proxied, wafAction, wafTuned, originPulls |

Every record also carries the exact config path it came from, which is how evidence stays traceable.

## Adding a vendor

Requirements do not change. Add an entry to `VENDORS` in `tools/asbuilt-vendors.mjs`:

```js
"cisco-ios": {
  present: (c) => typeof c.ciscoIos === "object",
  provides: {
    managementAccess: (c) => [{ _path: "ciscoIos.vty", permittedSources: c.ciscoIos.vty.permittedSources, protocols: c.ciscoIos.vty.protocols }]
  }
}
```

A requirement that names `cisco-ios` then goes from "cannot say" to met or not met, with no edit to the requirement. The same holds for a vendor that already exists. Supplying one more fact makes more requirements answerable, and the report's vendor columns show which. The lab ships mappings for Palo Alto, F5, Meraki, and Cloudflare. **Cisco platforms other than Meraki have no mapping**, so a requirement for them says "cannot say" until one is added.

## From a customer's as-built document to requirements

1. Take each statement the customer wants to be able to claim and give it their id and the section it came from.
2. If a fact in the table can answer it, write it as an automated requirement. Scope it to the vendors it covers.
3. If the model cannot answer it, either add the field to a vendor mapping or leave it as "cannot say", which is the true answer today.
4. If only a person can answer it, make it manual and say what evidence an attestation must show.
5. Review the "cannot say" list with the customer. It is the honest list of what the twin does not yet cover.

## Customer data

Real requirements, configurations, and attestations go in files named `*.client.json`, which git ignores. The tool refuses to run on real data from any other file name, and refuses to write a report file for it. It treats a configuration whose `twinId` does not start with `SYNTH-` as real. Print the report instead and keep it out of the repository.
