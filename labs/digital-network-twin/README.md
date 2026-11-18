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

## Commands

| Command | What it does |
|---|---|
| `npm run plan` | Prints one valid configuration order, with what each stage requires and produces |
| `npm run check` | Validates the dependency graph: missing producers, duplicate producers, cycles |
| `node tools/twin-sequence.mjs run <ids...>` | Applies stages in the order you give; a refused stage names what is missing |
| `npm run verify` | Applies the full plan and confirms the twin reaches `validation.passed` |
| `node tools/twin-sequence.mjs show <id>` | Prints one stage's full lesson |
| `npm run health -- --config=<file> --until=<id>` | Builds the twin to that stage and checks the config at each stage; add `--json` for a report |
| `npm test` | Runs the test suite: sequence, all 42 health checks, and the checklist |

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
4. A one-page design note that answers the checkpoints in your own words.
5. A residual-risk list drawn from the "What this twin cannot prove" section of the architecture document.

## Boundaries

- Synthetic data only. Addresses use RFC 5737 and RFC 1918 ranges, and names are placeholders.
- No vendor account, API, credential, or live device is needed or used. Do not add one to this project.
- Secrets such as the IPsec pre-shared key, the TLS private key, and any Cloudflare API token belong in your organization's secret store, never in a stage file or in this repository.
- The tools check sequence, dependencies, and the structure and consistency of the twin config. They do not validate vendor syntax, performance, licensing, or failover.

Vendor product names are trademarks of their owners and identify roles in this training model.
