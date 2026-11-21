# Topology

Generated from `config/twin-config.json` by `npm run topology`. Do not edit by hand.

```mermaid
flowchart LR
  subgraph internet["Internet and edge"]
    user["Users<br/>HTTPS 443"]
    cf["Cloudflare edge<br/>app.lab.example<br/>proxied<br/>SSL strict<br/>WAF block"]
  end
  subgraph ngfw["Palo Alto NGFW (default deny last)"]
    z_untrust["zone untrust<br/>ethernet1/1 198.51.100.2/24"]
    z_dmz["zone dmz<br/>ethernet1/2 10.20.0.2/24"]
    z_app["zone app<br/>ethernet1/3 10.30.0.1/24"]
    z_management["zone management<br/>ethernet1/4 10.99.0.1/24"]
    z_vpn_branch["zone vpn-branch<br/>tunnel.1 10.50.0.1/30"]
  end
  subgraph dc["Data center"]
    vip["F5 virtual server<br/>10.20.0.100:443<br/>TLSv1.2<br/>SNAT automap"]
    pool["Pool app-pool<br/>http monitor"]
    m_10_30_0_11["Member<br/>10.30.0.11:8080"]
    m_10_30_0_12["Member<br/>10.30.0.12:8080"]
  end
  subgraph mgmt["Management"]
    panorama["Panorama<br/>10.99.0.5"]
  end
  subgraph branch["Branch"]
    lan["Branch clients<br/>10.40.0.0/24"]
    mx["Meraki MX<br/>WAN 198.51.100.40"]
  end
  user -->|"HTTPS 443"| cf
  cf -->|"origin 198.51.100.2"| z_untrust
  z_dmz ---|"dmz"| vip
  vip -->|"default pool"| pool
  pool --> m_10_30_0_11
  z_app ---|"app"| m_10_30_0_11
  pool --> m_10_30_0_12
  z_app ---|"app"| m_10_30_0_12
  panorama -.->|"manages https ssh"| z_management
  lan --> mx
  mx ==>|"IPsec IKEv2 to 198.51.100.2"| z_vpn_branch
  z_untrust -->|"edge-https<br/>tcp/443<br/>NAT to 10.20.0.100:443"| z_dmz
  z_vpn_branch -->|"branch-https<br/>tcp/443"| z_dmz
  z_dmz -->|"f5-to-pool<br/>tcp/8080"| z_app
```

## Reading the diagram

- Boxes inside the NGFW are zones. Each arrow between zones is an allow rule, labeled with the rule name, service, and any NAT. Anything not drawn is denied by the default rule.
- A thin line with no arrow attaches a device to its zone.
- A dotted arrow is management. A thick arrow is the IPsec tunnel.
- A red arrow is an allow rule into the app zone from anywhere except the DMZ. The F5 is meant to be the only path to the pool, so a red arrow is a finding.
