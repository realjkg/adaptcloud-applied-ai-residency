# Manual UI guide

A person-at-the-keyboard check of the lab's web page. It covers two main journeys: **two learners who must not see each other's work**, and the **maintenance scenario**. A short SD-WAN check is at the end.

## What this guide is, and is not

- It is a **human check on screen**. It adds to the automated browser tests; it does not replace them, and passing it does not prove anything the automated tests do not already show.
- Everything here uses **made-up data and simulated devices**. No real firewall, Meraki network, Cloudflare zone, or load balancer is contacted.
- It uses the **local test sign-in** (a list of named test users). It does **not** test the deployed learner service, which signs people in through a company identity provider. The things that only the deployed service can show are listed under "Not covered" at the end.
- A result here is evidence for the commit you tested. Write that commit down (see "Record your run").

## Before you start

You need Node 22 and a checkout of this repository.

```
cd labs/digital-network-twin
npm run control:learner:local
```

It prints `Learner service, LOCAL TEST entry (persona sign-in), on http://127.0.0.1:3500/`. Open that address. If the port is busy, use `npm run control:learner:local -- --port=3501` and open that port instead.

Everything is kept in memory. To start again from a clean slate, stop the server (Ctrl+C) and start it again.

### The test users

Each button on the sign-in screen is one test user. The page shows the name and the role.

| Button | Lab | What this user can do |
|---|---|---|
| Vera Viewer (viewer) | A | Look only |
| Omar Operator (operator) | A | Collect snapshots, ask for changes, run approved changes, plan and deploy in the scenario |
| Ana Approver (approver) | A | Approve or reject other people's changes |
| Adel Admin (admin, approver) | A | Everything above, plus schedule and readiness checks |
| Olga Operator (operator) | B | Same as Omar, but in lab B |
| Abel Approver (approver) | B | Same as Ana, but in lab B |

**Use two browsers, or one normal window and one private window.** A sign-in is remembered by the browser. If you sign in as a lab B user in the same window, you replace your lab A sign-in and the test is meaningless. Lab A users go in window 1. Lab B users go in window 2 (a private window or a different browser).

## Journey 1: two learners cannot see or touch each other's work

### 1. Create work in lab A (window 1)

1. Sign in as **Omar Operator (operator)**.
2. In the left column under **Operate**, check the line says "Signed in as Omar Operator (operator). Mode: simulator."
3. Open the **Snapshot** dropdown. **Expect:** four entries, each ending in `(lab-a)`.
4. Under **Collection**, press **Collect now**. **Expect:** a new entry appears in the Snapshot dropdown that starts with `Simulated collection (lab-a)`.
5. Under **Request a change**, tick **f5 pool**, then press **Submit request**. **Expect:** a card under **Changes** with an id like `CHG-XXXXXXXXXX` and the word `pending_approval`. Write the id down.
6. Under **Target change**, choose **Simulated firewall 019801234560** and the change type to create an address object. Fill in a name such as `web-a` and the address `10.1.0.0/24`, then press **Plan this change**. **Expect:** a card under **Target changes** with an id like `OP-XXXXXXXXXX`, a "Dry-run diff" box (a preview of exactly what would change) showing one added line, and `pending_approval`. Write the id down.

### 2. Look from lab B (window 2)

1. Sign in as **Olga Operator (operator)**.
2. **Snapshot** dropdown. **Expect:** four entries, each ending in `(lab-b)`, and none ending in `(lab-a)`.
3. **Changes**. **Expect:** "No changes yet." (Lab A's change is not listed.)
4. **Target change** device list. **Expect:** only three devices, whose names start with `Simulated firewall 019801234561`, `Simulated MX, Plano branch`, and `Simulated Cloudflare zone, lab B`. The lab A devices (`...560`, `Austin branch`, `lab A`) are absent.
5. Press **Collect now** and submit a change of your own. **Expect:** they appear for Olga only. Go back to window 1 and reload: Omar still sees only his own.

### 3. Try lab A's records by their real ids (window 2)

The page has no way to type another lab's id, so use the browser's address bar. These are read-only requests that show what the server answers.

| Open this address in window 2 | Expect |
|---|---|
| `http://127.0.0.1:3500/api/changes/` followed by lab A's change id | `{"ok":false,"code":"not_found"}` |
| `http://127.0.0.1:3500/api/changes/CHG-0000000000` (an id that never existed) | exactly the same text as the line above |
| `http://127.0.0.1:3500/api/changes` | `{"changes":[...]}` containing only lab B's changes |
| In window 1, open `/api/snapshots` and copy one `digest` from lab A. In window 2 open `/api/snapshots/` followed by that digest | `{"error":"not_found"}` |

The point: **another lab's real id gets exactly the same answer as an id that does not exist.** If lab B ever sees lab A's change, snapshot, or device, stop and report it as a serious problem.

Approving, running, or undoing another lab's work cannot be tried from the address bar (those need a form submission). The automated tests cover them with valid ids. This guide only checks what a person can see.

### 4. Each role sees the right buttons

| Sign in as | Expect |
|---|---|
| Vera Viewer | No **Collect now**, no **Request a change**, no **Target change**. The **Live readiness** box shows results but no **Run storage check** or **Run read-only checks** buttons. |
| Ana Approver (window 1), looking at Omar's pending change | **Approve** and **Reject** buttons on the card. No **Submit request**. |
| Omar Operator, looking at his own pending change | No **Approve** button, because Omar is an operator, not an approver. |

### 5. Approval really needs a second person (window 1)

1. As Omar, request a change (step 1.5). Note it shows `pending_approval`.
2. Sign out and sign in as **Ana Approver**. Press **Approve** on Omar's change. **Expect:** the status line says it was approved, and the card shows `approved` and "approved by Ana Approver".
3. Sign out and sign in as Omar. **Execute** appears. Press it. **Expect:** `completed`.
4. Sign out and sign in as **Adel Admin**. Request a change, then press **Approve** on your own request. **Expect:** a refusal message containing `self_approval`, and the card stays `pending_approval`.
5. For the target change from step 1.6, repeat approve, then **Execute**. **Expect:** `completed`. Then press **Plan a rollback**. **Expect:** a new card marked as a rollback that needs its own approval, and nothing removed yet.

If you sign out between users, the page reloads and asks you to choose a test user again.

## Journey 2: the maintenance scenario (lab A, window 1)

Sign in as **Omar Operator**. Find the **Maintenance scenario** box in the left column.

### Starting state

**Expect:**
- "Deployed revision 1: GET /health, expecting "200"."
- "Observed pool: available (2 of 2 members healthy)." and two lines, `app-1 ...: healthy, expected response, status 200` and `app-2 ...: healthy, expected response, status 200`.
- "Known-good revision: 1. Backend builds: app-1 2026.11, app-2 2025.06."
- Under **Revisions**, one card.

### Preview first, change nothing

1. Change **Monitor path** to `/healthz` (leave the expected response as `200`). Press **Preview change**.
2. **Expect** a plan box: "Plan PLN-... (change) from revision 1: predicted pool degraded (1 of 2 members healthy)." and a highlighted line "app-2: healthy to unhealthy (unsuccessful status, status 404)". app-1 is listed as healthy to healthy.
3. **Check the preview changed nothing.** The "Observed pool" line still says `available (2 of 2 ...)`, and **Revisions** still has one card.

Why it happens: the older backend (app-2) does not have a `/healthz` page, so it answers "not found". A preview exists to show you this before it reaches the pool.

### Deploy, then look at what actually happened

1. Press **Deploy to the simulator**. **Expect** a status line: "Deployed as revision 2. Observed pool: degraded (1 of 2 members healthy)."
2. **Expect:** "Deployed revision 2: GET /healthz ...", the observed pool now degraded with app-2 unhealthy, and two cards under **Revisions** (revision 2 marked "(deployed)").
3. "Known-good revision" still says 1.

### Restore the good version

1. On the revision 1 card press **Plan a restore of revision 1**. **Expect** a plan box labeled `(restore)` predicting `available (2 of 2 members healthy)`.
2. Press **Deploy to the simulator**. **Expect:** "Deployed as revision 3", the pool `available` again, and **three** cards under **Revisions**. Revision 3 says "Restore of revision 1." Nothing was erased: history only grows.

### Checks around the edges

| Do this | Expect |
|---|---|
| Preview with the path `/a b` | "Not planned: monitor_invalid" with a short reason. Nothing changes. |
| Preview with the current path and response | "Not planned: no_change." |
| Type a new path, then wait a few seconds without pressing anything | The text you typed is still there (the page must not wipe it). |
| Open the page in two tabs as Omar. In both, preview the same new path. Deploy in tab 1, then deploy in tab 2 | Tab 2: "Not deployed: stale_plan_new_plan_required." Only one new revision exists. |
| Press **Deploy** twice quickly on one plan | One new revision, not two. |
| Sign in as **Vera Viewer** | The box shows the revisions and the pool, but no **Preview change** and no restore buttons. |
| In window 2, as **Olga Operator** | Revision 1 only, pool `available`. Lab A's deploys are not visible. |

## Quick look: SD-WAN panel

The **SD-WAN simulation** box is in the left column once you are signed in (any user). It takes numbers you type, so it checks the decision rules, not a measurement. The starting limits are latency 100, jitter 20, loss 1, and both lines start healthy (40, 5, 0.1).

| Do this, then press **Evaluate uplinks** | Expect |
|---|---|
| Nothing | `wan1 — preferred healthy` |
| WAN 1 latency 101 | `wan2 — preferred ineligible` |
| WAN 1 latency back to 40 | `wan1 — return to preferred` |
| Failback: Sticky. WAN 1 loss 2 | `wan2 — preferred ineligible` |
| WAN 1 loss back to 0.1 | `wan2 — sticky backup` (it stays on the backup) |
| WAN 2 jitter 21 | `wan1 — return to preferred` (the backup went bad, so go back) |
| Also WAN 1 jitter 21 | `No eligible uplink — no eligible uplink` |
| Press **Reset simulation** | Fields and result are cleared |
| A value exactly at its limit (for example latency 100) | counts as healthy |

## Not covered by this guide

- **Real sign-in.** The deployed learner service uses a company identity provider. With it you would check that a person who is signed in but not enrolled in any lab is turned away, and that the test-user sign-in does not exist. This needs an identity provider test app and the deployed service; the automated tests check it with a stand-in identity provider only.
- **Real devices.** Nothing here reaches a real vendor system.
- **Reading CI results.** GitHub's checks are separate evidence and apply to one commit each.
- **Other browsers and screen sizes, accessibility, and appearance.** The automated tests use one browser at desktop size, and nothing checks accessibility or appearance. Add those if you need them.

## Record your run

Write down the commit you tested (`git rev-parse HEAD`), the date, your name, and for each journey: pass, fail, or not run, with a note for anything unexpected.

| Item | Result | Note |
|---|---|---|
| Commit tested | | |
| Journey 1, step 1 (lab A work created) | | |
| Journey 1, step 2 (lab B sees only lab B) | | |
| Journey 1, step 3 (real ids look like missing ids) | | |
| Journey 1, step 4 (roles see the right buttons) | | |
| Journey 1, step 5 (second person approves) | | |
| Journey 2 (preview, deploy, restore, edge checks) | | |
| SD-WAN quick look | | |
