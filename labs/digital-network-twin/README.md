# Digital network twin lab

A self-contained lab for learning how a multi-vendor network path is built, in order, and why each component depends on the ones before it. You configure nothing on real equipment. You build a model of the path stage by stage, and a local tool refuses any stage whose prerequisites are missing.

The path connects a branch, through an IPsec tunnel, and a public user, through the Cloudflare edge, to an application behind an F5 BIG-IP, with a Palo Alto Networks firewall as the perimeter and Panorama for management.

| Vendor | Role |
|---|---|
| Cisco Meraki MX | Branch gateway and IPsec spoke |
| Cloudflare | Public DNS, proxy, WAF, TLS to the origin |
| Palo Alto Networks | Perimeter NGFW, default-deny policy, IPsec hub, Panorama management |
| F5 BIG-IP LTM | Virtual server, TLS termination, pool and health monitor |

## Start here

1. Read `docs/ARCHITECTURE.md`. It explains the path, the layers, the addressing plan, and the design decisions.
2. Run the plan and read the stages in order:

   ```bash
   npm run plan
   node tools/twin-sequence.mjs show 01
   ```

3. For each stage, read its lesson, then try to apply it out of order and read the refusal:

   ```bash
   node tools/twin-sequence.mjs run 06        # refused: the pool, certificate, and interfaces are missing
   ```

4. When you are ready, verify the full sequence:

   ```bash
   npm run verify
   ```

## Build your own config with the health agent

The stages describe what to configure. The health agent checks that what you wrote is valid, one stage at a time.

```bash
cp config/starter-config.json my-config.json
npm run health -- --config=my-config.json --until=01
```

1. Open `docs/CHECKLIST.md` and `stages/01-...md`. Add that stage's section to `my-config.json`.
2. Run the agent up to the stage. It applies each stage to the twin, runs that stage's checks, and stops at the first failure. No later stage is checked against a config that is already unhealthy.
3. Fix the config, not the check. Tick the checklist items as they pass, then move to the next stage and raise `--until`.
4. Compare with `config/twin-config.json`, the finished reference, after you have tried a stage yourself.

`HC-00-SECRET` runs at every stage. Keep keys and pre-shared secrets out of the config. Refer to them as `secret-store://...`.

In Claude Code, the `twin-health-agent` subagent (`.claude/agents/twin-health-agent.md` at the repository root) runs the same command read-only and explains each failure from the checklist and stage files.

Read the vendor pages for each stage in `docs/REFERENCES.md` before configuring it.

## Render the topology

The twin draws itself from the config. Run it at any point in the build:

```bash
npm run topology -- --config=my-config.json     # Mermaid text
npm run topology -- --out=docs/TOPOLOGY.md      # Markdown with a legend
```

Only sections that exist in the config are drawn, so the diagram grows stage by stage. Each allow rule becomes a labeled arrow between zones, with any NAT on it. An allow rule into the app zone from anywhere except the DMZ is drawn in red, because the F5 is meant to be the only path to the pool. The finished reference is in `docs/TOPOLOGY.md`.

**Exercise.** Before you render, sketch the diagram you expect for your config. Then render it and reconcile every difference. Next, add a `branch-to-pool` allow rule (from `vpn-branch` to `app`, source `10.40.0.0/24`, destination `10.30.0.0/24`, `tcp/8080`) above `default-deny`, and render again. Find the red arrow, then say which health check catches the same mistake and at which stage.

## Render the plan (plan-only)

```bash
npm run render:iac        # writes rendered/
```

| Output | Contents |
|---|---|
| `rendered/changeset.json` | 35 ordered, create-only operations for all four vendors, in stage order, with rule positions |
| `rendered/terraform/cloudflare` | Terraform for the DNS record, SSL mode, and managed WAF, plus a mock-provider plan test |
| `rendered/terraform/f5` | Terraform for the monitor, pool, certificate, client SSL profile, and virtual server, plus a mock-provider plan test |

The renderer refuses to run unless every stage passes its health checks, so no infrastructure code is produced from a model that already has a finding. Credentials come from the environment, the certificate and key are sensitive variables with no default, and the pre-shared key stays a `secret-store://` reference.

**What is checked, and what is not.**

- Checked here: the HCL parses and is canonically formatted (`terraform fmt`), the output is deterministic and matches the committed files, nothing from the config can become an HCL interpolation, and no secret appears in any output.
- Not checked here: resource and attribute names against the real provider schemas, and the mock-provider plan tests have not been run. Both need the provider registry. In an environment that can reach it, run `terraform init` and `terraform validate`, then `terraform test`, in each Terraform directory. Fix any attribute that the pinned provider version rejects, and treat that fix as part of the exercise.
- Not rendered: Palo Alto and Meraki Terraform. Their provider schemas differ between major versions, so those two vendors appear in the change set only. Authenticated Origin Pulls and the F5 minimum TLS version are noted in comments for the same reason.

Never run `terraform apply` from this lab. Applying to real infrastructure needs its own approval, credentials, and a tested teardown.

## Test a change before it happens: return to office

```bash
npm run rto
```

Models what happens to the corporate Wi-Fi, the address pool, and the site uplink when many more people are in the office more days a week, using Meraki's published sizing method. It reports the share of users on a healthy, watch, or over-capacity zone, a day-by-day sweep showing where the first problem appears, and how many access points to add. Inputs are synthetic and every parameter says whether it came from Meraki, is a placeholder, or needs client data. See `docs/RTO_WIFI_SCENARIO.md` for the question to put to a client, the demo, and the data to ask for, and `docs/RTO_WIFI_REPORT.md` for the committed output. It is capacity arithmetic, not an RF survey. Real client numbers go in a `*.client.json` file, which git ignores.

## Provision and deprovision (guarded)

The control surface for applying and destroying the twin, tested against a simulated lab tenant. See `docs/PROVISIONING.md`.

```bash
npm run roundtrip
```

This applies all 35 operations to a simulated tenant that already holds two objects the twin does not own, destroys them again, and checks that the tenant is unchanged and the two unmanaged objects are untouched. Run it, then read the engine in `tools/provision.mjs`.

The gate refuses by default. It acts only on a tenant named `lab` that is on an exact allowlist, requires a dry run of the exact change set, and requires a human approval bound to one action, one tenant, and the change set's digest. It reads all current state before the first write, never adopts or deletes an object it does not own, reads back every write, and rolls back only what a failed run created.

**Exercise.**

1. Copy `config/provision-policy.example.json` to `provision-policy.json`, set `"enabled": true`, and run `plan`.
2. Use `approval-template`, complete it as the approver, and `apply`. Then change one attribute in your config and try the same approval again. Say why it is refused.
3. Edit `.twin-lab-state.json` to change `cloudflare/zone-setting/ssl`, and re-run `plan`. Say what the drift refusal protects against.
4. Destroy with `"allowDestroy": true`, then destroy again, and explain both results.

**Live adapters exist but have never been run.** Cloudflare DNS records and four F5 object kinds can be created and deleted on a real tenant. They were written without access to a real system, so they are tested only against an in-memory fake, are off by default, and sit behind the same gate. Palo Alto and Meraki are deliberately refused. Read `docs/adr/0001-live-provisioning-authorization.md` and the "Live adapters" section of `docs/PROVISIONING.md` before you consider a live run. A first run belongs on a disposable lab tenant you own, limited with `--only` to one low-risk object, never on production, an employer, or a customer.

## Commands

| Command | What it does |
|---|---|
| `npm run plan` | Prints one valid configuration order, with what each stage requires and produces |
| `npm run check` | Validates the dependency graph: missing producers, duplicate producers, cycles |
| `node tools/twin-sequence.mjs run <ids...>` | Applies stages in the order you give; a refused stage names what is missing |
| `npm run verify` | Applies the full plan and confirms the twin reaches `validation.passed` |
| `node tools/twin-sequence.mjs show <id>` | Prints one stage's full lesson |
| `npm run health -- --config=<file> --until=<id>` | Builds the twin to that stage and checks the config at each stage; add `--json` for a report |
| `npm run topology -- --config=<file>` | Renders the topology as Mermaid; `--out=<file>` writes Markdown |
| `npm run render:iac` | Renders the change set and Terraform into `rendered/`; refuses an unhealthy config |
| `npm run rto` | Return-to-office Wi-Fi what-if: before and after, where it breaks first, and APs to add |
| `npm run demo:check` | Pre-flight for a client working session: runs every step in `docs/WORKING_SESSION.md` and fails if one stops behaving as described |
| `npm run roundtrip` | Applies then destroys the twin on a simulated tenant and proves it is unchanged |
| `node tools/provision-cli.mjs <plan\|apply\|destroy\|approval-template>` | Guarded provisioning against the simulated tenant; see `docs/PROVISIONING.md` |
| `npm test` | Runs the test suite: sequence, 42 health checks, the checklist, the renderers, and the provisioning gate |

## Learning path

Work through the stages in order. Each one has the same sections, so you can compare them:

- **Why** explains the position of the stage in the sequence.
- **Configure (conceptual)** lists the steps in vendor terms, not device commands.
- **Verify** states what a correct result looks like.
- **If you do it out of order** explains the failure you would see, and why the twin refuses the stage.

| Stage | Title | Vendor |
|---|---|---|
| 01 | Addressing and inventory | all |
| 02 | Management plane first | Palo Alto Networks (Panorama) |
| 03 | Zones and interfaces | Palo Alto Networks |
| 04 | Pool and health monitor | F5 BIG-IP |
| 05 | TLS certificate chain | F5 and Cloudflare |
| 06 | Virtual server with TLS termination | F5 BIG-IP |
| 07 | Security policy, default deny last | Palo Alto Networks |
| 08 | DNS and proxy | Cloudflare |
| 09 | WAF and origin lock | Cloudflare |
| 10 | IPsec tunnel from the branch | Cisco Meraki MX and Palo Alto Networks |
| 11 | Branch policy and routing | Cisco Meraki MX, Palo Alto Networks, F5 |
| 12 | End-to-end validation | all |

## Checkpoints

Answer these before you move on. You should be able to answer each from the stage files and the architecture document.

1. Why does management come before the NGFW zones, not after the application works?
2. Why does the Palo Alto default-deny rule sit last, and what breaks if it is first?
3. Why is the branch connected with IPsec instead of Cisco Meraki Auto VPN?
4. Why must Cloudflare's SSL mode be Full (strict), and which earlier stage makes that possible?
5. Which single component, if it fails, stops all user traffic? Which one stops only branch traffic?
6. In what order would you roll back the twin, and why?

## Evidence pack

For a review or a portfolio, collect:

1. The output of `npm run plan` and `npm run verify`.
2. The refusal output from at least three out-of-order `run` commands, with a sentence on each explaining the missing dependency.
3. The health agent's report for your own config through stage 12, plus one run where you introduced a fault and the agent halted.
4. The rendered topology of your config, with your pre-render sketch and the differences you reconciled.
5. Your `rendered/changeset.json`, plus the result of `terraform validate` and `terraform test` if you ran them.
6. A one-page design note that answers the checkpoints in your own words.
7. A residual-risk list drawn from the "What this twin cannot prove" section of the architecture document.

## Boundaries

- Synthetic data only. Addresses use RFC 5737 and RFC 1918 ranges, and names are placeholders.
- No vendor account, API, credential, or live device is needed or used. Do not add one to this project.
- Secrets such as the IPsec pre-shared key, the TLS private key, and any Cloudflare API token belong in your organization's secret store, never in a stage file or in this repository.
- The tools check sequence, dependencies, and the structure and consistency of the twin config. They do not validate vendor syntax, performance, licensing, or failover.

Vendor product names are trademarks of their owners and identify roles in this training model.
