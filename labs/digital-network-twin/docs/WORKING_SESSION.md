# Digital twin working session: topology

A runbook for a 60-minute session with a client's network leads. It maps the agenda to what the lab can show, says plainly what it cannot, and prepares the questions for the parts where we mostly listen. Everything in the lab is synthetic. Never paste client configurations into this repository.

## Background, from the team

- The client lead took over networking for broadcast and corporate this summer.
- On the July 29 call he said his networking team wants a dev lab as part of their FY27 initiative, which is funded and started October 1.
- Our network lead walked him through the twin work. He liked it, especially the documentation piece, and asked whether it works across vendors.
- The estate is Cisco, F5, Palo Alto, and Meraki.
- The attendees are network leads.

**Not known yet:** what the FY27 initiative covers, what the network leads own, and their tooling. The first 15 minutes exist to find out.

## Ground rules

1. In section 2 we listen. Do not pitch before we know what they have.
2. Say only what the claims table below supports. Where it says "not built", say that.
3. Ask which Cisco platforms they mean. The lab models Meraki, not other Cisco platforms.
4. Broadcast networks bring timing, multicast, and latency constraints that this lab does not model. Ask, do not assume.

## Run of show

| Min | Item | Lead | In the lab |
|---|---|---|---|
| 5 | Intros | Account lead | none |
| 15 | Their network picture | Account lead, everyone listens | capture sheet below |
| 20 | What a twin looks like | Our network lead | steps 1 to 7 |
| 15 | What it would look like here | Our network lead, SA on scoping | section 4 |
| 5 | Next steps and owners | Account lead | table at the end |

## 2. Their network picture (15 min, listen)

Ask, then stay quiet. Write answers in the capture sheet.

- What does the estate look like today, by site type and by vendor? Which Cisco platforms?
- What does FY27 cover, and what is out of scope? Who funds and who decides?
- Where is the pain: outages after change, slow change, stale diagrams, knowing what is actually deployed, testing?
- How do changes get made and approved today? How long does a typical one take, and how often does one go wrong?
- What do you use now for the source of truth: a CMDB, spreadsheets, Visio, Git, the vendors' own managers (Panorama, BIG-IP management, the Meraki dashboard)?
- What automation exists: Ansible, Terraform, scripts, nothing?
- What does broadcast need that corporate does not?
- What is a dev lab to you: virtual appliances, spare hardware, a cloud lab? Who has licenses?

| Topic | What they said | Owner | Follow-up |
|---|---|---|---|
| Estate and platforms | | | |
| FY27 scope and timing | | | |
| Pain points, ranked | | | |
| Change process | | | |
| Source of truth today | | | |
| Tooling and automation | | | |
| Dev lab plans | | | |
| Broadcast constraints | | | |

## 3. What a twin looks like (20 min)

Run `npm run demo:check` first. Run every command from `labs/digital-network-twin`.

**Step 1 (3 min). One source of truth, drawn.** Open `docs/TOPOLOGY.md` on GitHub, which draws the diagram, or run `npm run topology`. Show `config/twin-config.json`. *Say:* one file describes the path across the vendors, and the picture is derived from it, not drawn by hand.

**Step 2 (3 min). The documentation stays current.**
```bash
diff <(npm run topology --silent) <(npm run topology --silent -- --config=demo/proposed-change-risky.json)
```
Expect a new rule edge in red. *Say:* the topology, the checklist, the change set, and the what-if report are generated from the model, and a test fails if a committed copy drifts. That is the documentation piece, and it is why it stays accurate.

**Step 3 (5 min). Validate a change before it reaches the network.**
```bash
npm run health -- --config=demo/proposed-change-safe.json
npm run health -- --config=demo/proposed-change-risky.json
npm run topology -- --config=demo/proposed-change-risky.json
```
The safe change, a third pool member, passes all 12 stages. The risky one, a rule that lets the branch reach the pool around the F5, halts at stage 11 on `HC-11-ISOLATION`, names the check, and checks nothing after it. The topology shows the same mistake as a red arrow. *Say:* 42 checks cover addressing, management exposure, rule order, TLS, tunnels, and isolation, and an approval is tied to the exact change set, so an edited change needs a new one. *Do not say* it proves the real devices will behave: it checks the model, not vendor syntax or runtime behavior.

**Step 4 (3 min). You do not need all your data first.**
```bash
npm run topology -- --config=demo/partial-1-ngfw.json
npm run health -- --config=demo/partial-1-ngfw.json --until=03
npm run health -- --config=demo/partial-2-ngfw-and-f5.json --until=06
```
*Say:* a team can start with one platform's export. The twin checks and draws what it has, and says what is missing, so the source of truth can grow one platform at a time. This is where agents help: the health agent checks a config as it is built, and the same approach can read exports into the model. The reading agent is not built yet, so call it phase-one work.

**Step 5 (3 min). Across vendors.**
```bash
node -e 'const c=require("./rendered/changeset.json");const n={};for(const o of c)n[o.vendor]=(n[o.vendor]??0)+1;console.log(n)'
```
Then open `docs/API_NOTES.md`. *Say:* one model, one ordered change set, a vendor-specific layer underneath. The differences are real and recorded: F5 and Cloudflare objects take an ownership note, Palo Alto commit is a separate call, and Meraki returns 404 for a bad key. Those are exactly why each vendor needs its own careful adapter.

**Step 6 (3 min). Model a future state.**
```bash
npm run rto
```
*Say:* this takes a planned change, 500 people moving from one day a week in the office to four, and shows what breaks first. With the synthetic numbers it is the address pool, then the Wi-Fi. SD-WAN is not modeled, but it would use the same pattern: a scenario in, findings out.

**Step 7 (optional, 2 min). Rehearse the change and undo it.**
```bash
npm run roundtrip
```
*Say:* the apply and the undo run against a simulated tenant that already holds objects the twin does not own, and the tenant ends exactly as it began.

**Step 8 (optional, 3 min). Claim exactly against their as-built requirements.**
```bash
npm run asbuilt
```
Show the traceability table: each requirement in the customer's own id and document reference, one verdict, and a column per vendor. Point at three rows. A requirement checked across vendors is met on one and "cannot say" on another, because the model does not carry that field. The same requirement scoped to one vendor is met. A Cisco platform the lab has no mapping for says "cannot say", never "met". *Say:* it only claims what it can show, and the "cannot say" list is the honest list of what the twin does not cover yet. A person's attestation is shown as one and never counted as a machine check. See `docs/ASBUILT_REQUIREMENTS.md`. Ask them for their as-built document so the requirements can be written in their ids.

## What we can and cannot say

| What may come up | What the lab shows | Say |
|---|---|---|
| A simulation twin kept in sync with production | **Not built.** The lab models a source-of-truth file. Nothing reads from devices. Drift detection exists only against a simulated tenant, and the live adapters have never run against a real system. | "That is what a first phase would build: reading state from your platforms into the source of truth, then comparing." |
| Changes validated before they hit the network | **Shown at configuration level.** 42 checks over 12 stages, a risky change halts at a named check, approvals are tied to the exact change set. It is not a device emulation. | "It catches the class of mistake that is visible in the design and the config. It does not replace testing on the platform itself." |
| Docs that stay current | **Shown for generated artifacts.** Topology, checklist, change set, and report come from the model and tests fail on drift. Hand-written runbooks are not kept current automatically. | "Anything derived from the model stays current. Prose still needs an owner." |
| Future-state modeling like SD-WAN | **Partly.** The Wi-Fi what-if shows the pattern. SD-WAN is not modeled. | "We have shown the pattern on a Wi-Fi change. SD-WAN is the next scenario type." |
| Works across vendors | **Partly.** The model carries Meraki, Palo Alto, and F5 from their estate, plus Cloudflare, which is not in theirs. Cisco platforms other than Meraki are not modeled. Live adapters cover Cloudflare DNS records and four F5 object kinds, and have never run against a real system. Palo Alto and Meraki adapters are not built. | "The model is vendor-neutral. Each vendor needs its own adapter, and we would start with the platforms you care about most." |
| Checked against our as-built requirements | **Shown on synthetic requirements.** Each requirement gets one of five verdicts with evidence, across Palo Alto, F5, Meraki, and Cloudflare, bound to digests of the config and requirements. It speaks only for the modeled config. A requirement the model cannot answer is "cannot say", and Cisco platforms other than Meraki have no mapping. We have not seen their as-built document yet. | "Give us the statements you need to be able to claim. We will write them in your ids and show you which the twin can answer today and which it cannot." |
| Agents can help build the source of truth | **Partly.** A health agent checks a config as it is built, and the model draws whatever exists. No agent that ingests configs or documents into the source of truth exists yet. | "You do not have to get everything in one place first. The agent that reads your exports into the model is something we would build with you." |

## 4. What it would look like here (15 min)

### Which parts to twin first

These are hypotheses to test with them, not recommendations. A good first slice is where change is frequent, a mistake is costly, the platform has a usable API, and the people who own it will take part.

- Palo Alto policy and F5 virtual servers on a corporate edge path, because rule order and isolation mistakes are exactly what the checks catch.
- A Meraki branch or campus, because it has a documented API and a clear what-if, like the Wi-Fi example.
- Not first: anything where timing or multicast dominates, such as broadcast, until we understand those constraints.

### Scoping questions for the SA

- Which platforms and versions, and which management layer owns the truth for each?
- Can we get sanitized exports, or read-only API access to a non-production system? Under what data handling rules?
- What is the dev lab: which virtual appliances, which licenses, who owns it?
- How are changes approved, and where would a pre-change check fit?
- Which team maintains the diagrams today, and what would "current" mean to them?
- What would make the first phase a success in their words?

### What we would need from them

| Need | Why |
|---|---|
| Their as-built document, or the statements they want to claim | To write requirements in their ids and show what is answerable |
| A named owner for the first slice | Someone who can answer questions about it |
| Sanitized exports or read-only API access for that slice | To build the source of truth from facts |
| The current change process and an example of a recent change | To place the checks where the change is reviewed |
| Their existing diagrams and standards | To compare the model with what they believe |
| Dev lab details and license entitlement | To decide what can be rehearsed on real software |
| Data handling rules | Real configurations stay in their environment |

### Rough shape of a first phase

A hypothesis to react to. Durations are set with the SA after discovery.

1. **Discover.** Confirm scope, owners, tooling, and the first slice.
2. **Source of truth for the slice.** Read their exports into a model, one platform at a time, and draw it.
3. **Checks.** Write the rules their team already follows as checks, and run them on real changes.
4. **Generated documentation.** Topology and reports derived from the model.
5. **Rehearse in the dev lab.** Apply a change to virtual appliances, verify it, and undo it.
6. **Review.** Decide what to extend and what the second slice is.

### Risks to say out loud

- A clean check is evidence about the model, not about the network.
- Without reading real state, the twin is only as current as the people who update it.
- Vendor behavior differs, and each vendor's adapter is real engineering work.
- Client data stays in their environment and out of this repository.

## 5. Next steps and owners

| Action | Owner | By |
|---|---|---|
| Send the capture sheet and a short summary of what we heard | Account lead | |
| Name the first slice and its owner | Client lead | |
| Share a sanitized export or read-only access plan for that slice | Client network lead | |
| Scoping call on platforms, lab, and data handling | SA with their network leads | |
| Draft first-phase shape for their reaction | Our network lead | |

## Before the call

- [ ] `npm run demo:check` passes.
- [ ] `docs/TOPOLOGY.md` opens in a viewer that draws Mermaid. Take a screenshot as a fallback.
- [ ] You can say, without notes, what is not built: sync with production, SD-WAN, Cisco beyond Meraki, Palo Alto and Meraki adapters, and an ingestion agent.
- [ ] Nobody has pasted client data into the repository.
