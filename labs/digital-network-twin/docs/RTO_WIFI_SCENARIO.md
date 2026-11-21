# Return-to-office Wi-Fi what-if

A worked scenario for showing how the twin tests a change before it happens. A client has refreshed its network, including new Meraki access points, and is moving a large group of staff from about one day a week in the office to about four. The twin takes that change as an input, models what it does to the Wi-Fi and the things around it, and shows where it breaks first.

Run it with `npm run rto`. The committed output is `docs/RTO_WIFI_REPORT.md`. **The numbers in this repository are synthetic.** They show how the model behaves and are not a prediction for any real site.

## The question to ask the client

Ask the client lead and the network leads together:

> If you add headcount back in the office, how would you test what that does to the new Wi-Fi before it happens?

It fits because the client lead already asked, earlier this year, whether changes to the corporate Wi-Fi could be modeled for their effect on users. This is that question with a real change attached.

Listen for how they answer today before you show anything. Useful follow-ups:

1. Which days will be busiest, and is the schedule fixed or flexible?
2. What would you look at to decide the Wi-Fi is struggling: client counts per AP, channel use, helpdesk tickets?
3. Who owns the corporate address plan and the site uplink? Wi-Fi is rarely the only thing that changes.
4. What was tested during the refresh, and was it tested with this many people?

Then show the twin as a way to answer the question with their numbers, not as a verdict.

## Confirm these before the meeting

These facts reached the team second-hand. Do not present them as the client's numbers until confirmed.

| Fact | Status |
|---|---|
| About 500 people are returning | Confirm whether that is 500 additional people on site per day, or 500 people whose schedule changes. The model assumes the second. |
| The requirement is about four days a week, up from about one | Believed, not confirmed |
| New Meraki access points were installed in a full refresh | Confirm the AP model, the count per floor, and whether switching and uplinks were also refreshed |
| The client lead asked about modeling Wi-Fi changes | Reported. Confirm the wording and the date with whoever heard it |

## What the twin does with it

```
scenario inputs  ->  capacity model  ->  before and after  ->  where it breaks first  ->  what to change
```

For each zone (a floor, a collaboration area) it computes devices per AP, 5 GHz clients per radio, throughput per AP against the AP's modeled capacity, and the AP's wired uplink. It also checks the corporate address pool and the site uplink, because those fail too. It reports the share of users sitting on a zone that is healthy, on watch, or over capacity, which is the user impact the client lead asked about. A day-by-day sweep shows at how many days a week each problem first appears. For each zone it says how many access points to add.

With the synthetic inputs, the order is instructive. The address pool is over at two days a week, a first zone goes on watch at three, and a first zone goes over at four, while throughput is never the limit. The limit is how many devices share each radio. The order of failure depends on the inputs, which is why the client's real numbers matter.

### A five-minute demo

1. `npm run rto`. Read the before and after table. Point at the share of users on an over-capacity zone.
2. Go to "Where the problem starts". Ask the room which of these they would have caught with only a Wi-Fi survey.
3. Change one assumption in a copy of `scenarios/rto-wifi.json`, for example `daysPerWeekAfter` to 3 or `devicesPerUser` to 3, and run `npm run rto -- --scenario=<file>` again. Ask what they would change.
4. Show the parameter table at the bottom. Every number says whether it came from Meraki, is a placeholder, or needs their data. Ask them to supply the placeholders.

For real client numbers, copy the scenario to a file named `<name>.client.json`. Git ignores those files, and the tool refuses to write a report file for real data. Keep client data out of the repository.

## What we need from the client

| Input | Where it comes from |
|---|---|
| People moving, current and planned days, and which days peak | HR and facilities, then check against badge data |
| Devices per person and how many are active at once | Dashboard client counts by AP, on a recent busy day |
| Throughput per active user at the busy hour | Dashboard usage by client or AP |
| AP model, count, and placement per floor | Install records and floor plans |
| Channel width and band steering settings | Dashboard radio settings |
| Corporate VLAN subnet, reserved addresses, lease time | Network team |
| Site uplink size, and how much traffic leaves the site | Network team and carrier |
| Which things the refresh did and did not change | Network lead |

## How the model works, and where it departs from Meraki

It follows [Meraki's high-density design guide](https://documentation.meraki.com/Platform_Management/Dashboard_Administration/Design_and_Configure/Architectures_and_Best_Practices/Cisco_Meraki_Best_Practice_Design/Best_Practice_Design_-_MR_Wireless/High_Density_Wi-Fi_Deployments) and the [client approximation guide](https://documentation.meraki.com/Wireless/Design_and_Configure/Architecture_and_Best_Practices/Approximating_Maximum_Clients_per_Access_Point):

- Aggregate throughput is per-user throughput times concurrent users. Dividing by per-AP throughput gives one AP count.
- Concurrent 5 GHz clients divided by about 25 per radio gives a second AP count. The larger of the two is the answer.
- A location is high density above 30 clients per AP. A 20 MHz channel width is recommended in dense areas.
- Per-AP throughput is roughly half the advertised data rate. The scenario uses the guide's 101 Mbps worked example, which is for 3-stream 802.11ac at 20 MHz. Replace it with the client's AP model and client mix.

Departures, stated plainly:

- Meraki's example rounds to the nearest AP. The model rounds up, which is the safer direction.
- Meraki does not publish an airtime or utilization target. The model's "watch" thresholds, 70% utilization and 80% of the client limit, are planning assumptions for the network leads to set, and they are labeled as placeholders.
- The guide's per-user figure of 3 Mbps is for HD video streaming. It is a conservative stand-in until the client's measured figure replaces it.

## What this does not prove

It is capacity arithmetic. It cannot see coverage holes, interference, channel reuse, roaming behavior, or a floor whose real layout differs from the zone model. A model that says "fine" is not a survey. Use it to decide where to look, then check with a predictive design or site survey, a pilot with one department, and the dashboard's own client and channel data.

Close the loop after the change. In the first weeks, compare what the model predicted with what the dashboard shows for clients per AP and channel use, and correct the assumptions that were wrong. That comparison is what turns a placeholder into a number the client trusts.
