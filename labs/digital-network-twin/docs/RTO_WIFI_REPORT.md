# Return-to-office Wi-Fi what-if

Scenario `SYNTH-RTO-WIFI-001`. **Synthetic inputs.** The numbers illustrate the mechanics and are not measurements of any real site.

500 people move from 1 to 4 days a week, on top of 150 people already on site. Peak-day factor 1.25 (the busiest day is above the weekly average). Capacity arithmetic only: it does not model coverage, interference, or roaming.

## Before and after

| | Before (1 d/wk) | After (4 d/wk) |
|---|---|---|
| People on site, peak day | 275 | 650 |
| Devices associated | 688 | 1625 |
| Users on a healthy zone | 100% | 0% |
| Users on a zone to watch | 0% | 55% |
| Users on an over-capacity zone | 0% | 45% |
| Corporate address pool (/22) | 78.2% ok | 184.7% OVER |
| Site uplink (1000 Mbps) | 34.6% ok | 81.9% WATCH |

## Zones

| Zone | APs | 5 GHz clients per radio, before | after | Status after | First limit reached | Add (Meraki method) | Add (with headroom) |
|---|---|---|---|---|---|---|---|
| Floor 1 open plan | 18 | 9.7 ok | 23 | WATCH | 5 GHz clients per radio: 23 per radio against about 25 | +0 | +3 |
| Floor 2 open plan | 16 | 11 ok | 25.9 | OVER | 5 GHz clients per radio: 25.9 per radio against about 25 | +1 | +5 |
| Floor 3 open plan | 14 | 10.4 ok | 24.7 | WATCH | 5 GHz clients per radio: 24.7 per radio against about 25 | +0 | +4 |
| Collaboration and cafe | 8 | 11 ok | 25.9 | OVER | 5 GHz clients per radio: 25.9 per radio against about 25 | +1 | +3 |

Access points to add: **2** by the Meraki method (25 5 GHz clients per radio), **15** to keep every zone under its watch level.
Address pool: 1869 leases against 1012 usable addresses. A /20 keeps it under 80%.

## Where the problem starts

| Days a week | People on site | Worst 5 GHz clients per radio | Zones to watch | Zones over | Address pool | Uplink | Add APs (min / headroom) |
|---|---|---|---|---|---|---|---|
| 1 | 275 | 11 | 0 | 0 | 78.2% ok | 34.6% ok | 0 / 0 |
| 2 | 400 | 15.9 | 0 | 0 | 113.6% OVER | 50.4% ok | 0 / 0 |
| 3 | 525 | 20.9 | 2 | 0 | 149.2% OVER | 66.1% ok | 0 / 2 |
| 4 | 650 | 25.9 | 2 | 2 | 184.7% OVER | 81.9% WATCH | 2 / 15 |
| 5 | 775 | 30.9 | 0 | 4 | 220.3% OVER | 97.7% WATCH | 11 / 28 |

## Parameters and where each came from

3 client data, 5 needs client data, 10 placeholder, 5 Meraki documentation.

| Parameter | Value | Source |
|---|---|---|
| `population.returningStaff` | 500 | client data |
| `population.existingOnSiteStaff` | 150 | needs client data |
| `population.daysPerWeekBefore` | 1 | client data |
| `population.daysPerWeekAfter` | 4 | client data |
| `population.workDaysPerWeek` | 5 | placeholder |
| `population.peakDayFactor` | 1.25 | placeholder |
| `clients.devicesPerUser` | 2.5 | placeholder |
| `clients.fiveGhzShare` | 0.85 | placeholder |
| `clients.activeShare` | 0.7 | placeholder |
| `traffic.perUserMbps` | 3 | Meraki documentation |
| `radio.channelWidthMHz` | 20 | Meraki documentation |
| `radio.perApThroughputMbps` | 101 | Meraki documentation |
| `radio.recommendedClientsPerRadio` | 25 | Meraki documentation |
| `radio.highDensityThresholdPerAp` | 30 | Meraki documentation |
| `radio.apUplinkMbps` | 1000 | needs client data |
| `limits.targetUtilization` | 0.7 | placeholder |
| `limits.watchFraction` | 0.8 | placeholder |
| `network.corpVlanPrefix` | 22 | needs client data |
| `network.reservedAddresses` | 10 | placeholder |
| `network.leaseCarryover` | 0.15 | placeholder |
| `network.wanUplinkMbps` | 1000 | needs client data |
| `network.wanShare` | 0.6 | placeholder |
| `zones` | Floor 1 open plan: 18 APs, 30% of staff; Floor 2 open plan: 16 APs, 30% of staff; Floor 3 open plan: 14 APs, 25% of staff; Collaboration and cafe: 8 APs, 15% of staff | needs client data |

Anything marked placeholder or needs client data must be replaced before the result is shown as a prediction.
