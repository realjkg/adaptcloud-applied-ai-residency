# Build checklist

Work through the stages in order. After each one, add that stage's section to your own config, then run the health agent up to that stage:

```bash
cp config/starter-config.json my-config.json
node tools/health-agent.mjs --config=my-config.json --until=01
```

Tick an item only when its check passes. `config/twin-config.json` is the finished reference, so use it to compare after you have tried the stage yourself. `HC-00-SECRET` runs at every stage and must always pass.

## Every stage

- [ ] **HC-00-SECRET** No credential-like field or private key material anywhere in the config

## Stage 01: Addressing and inventory

Run: `node tools/health-agent.mjs --config=my-config.json --until=01`

- [ ] **HC-01-PLAN** Addressing plan names every required address and the application hostname
- [ ] **HC-01-ADDR** Every planned address is in an RFC 5737 or RFC 1918 range
- [ ] **HC-01-UNIQUE** No host address is planned twice

## Stage 02: Management plane first

Run: `node tools/health-agent.mjs --config=my-config.json --until=02`

- [ ] **HC-02-MGT-SOURCE** Management permitted sources are a specific network inside the management subnet
- [ ] **HC-02-MGT-PROTO** Management uses HTTPS and SSH only
- [ ] **HC-02-PROFILE** Interface management profiles exist only in the management zone and are restricted

## Stage 03: Palo Alto zones and interfaces

Run: `node tools/health-agent.mjs --config=my-config.json --until=03`

- [ ] **HC-03-ZONES** Required zones are declared
- [ ] **HC-03-IFACE** Interfaces are unique, zoned, and addressed from the plan
- [ ] **HC-03-ROUTES** A default route and an app-subnet route exist

## Stage 04: F5 pool and health monitor

Run: `node tools/health-agent.mjs --config=my-config.json --until=04`

- [ ] **HC-04-MEMBERS** Pool has at least two unique members inside the app subnet
- [ ] **HC-04-MONITOR** Health monitor is HTTP(S) with a CRLF-terminated send string and an expected response

## Stage 05: TLS certificate chain

Run: `node tools/health-agent.mjs --config=my-config.json --until=05`

- [ ] **HC-05-CERT-NAME** Certificate subject matches the application hostname
- [ ] **HC-05-CERT-EXPIRY** Certificate is valid for at least 30 more days
- [ ] **HC-05-CERT-CHAIN** Certificate chain validates and is acceptable to Cloudflare Full (strict)

## Stage 06: F5 virtual server with TLS termination

Run: `node tools/health-agent.mjs --config=my-config.json --until=06`

- [ ] **HC-06-VIP** Virtual server listens on the planned VIP and port 443
- [ ] **HC-06-POOL** Virtual server uses the declared pool
- [ ] **HC-06-TLS** Client SSL profile uses TLS 1.2 or later and the declared certificate
- [ ] **HC-06-SNAT** SNAT automap keeps return traffic on the BIG-IP

## Stage 07: Palo Alto security policy

Run: `node tools/health-agent.mjs --config=my-config.json --until=07`

- [ ] **HC-07-ORDER** Default deny is the last rule
- [ ] **HC-07-NARROW** No allow rule uses any for zone, address, or service
- [ ] **HC-07-EDGE** Edge rule admits only the Cloudflare ranges to the pre-NAT origin on 443
- [ ] **HC-07-FRESH** Cloudflare range list was refreshed within 30 days
- [ ] **HC-07-NAT** Destination NAT maps the origin on 443 to the VIP on 443
- [ ] **HC-07-BRANCH** Branch rule admits only the branch LAN to the VIP on 443
- [ ] **HC-07-POOLPATH** Only the F5 self-IP may reach the pool, on the pool port
- [ ] **HC-07-LOG** Every rule logs

## Stage 08: Cloudflare DNS and proxy

Run: `node tools/health-agent.mjs --config=my-config.json --until=08`

- [ ] **HC-08-PROXIED** DNS record is proxied and points at the origin
- [ ] **HC-08-SSLMODE** SSL/TLS mode is Full (strict)

## Stage 09: Cloudflare WAF and origin lock

Run: `node tools/health-agent.mjs --config=my-config.json --until=09`

- [ ] **HC-09-WAF** Managed WAF is on, and block mode follows tuning
- [ ] **HC-09-ORIGIN** Origin accepts only Cloudflare: Authenticated Origin Pulls and a source-restricted edge rule

## Stage 10: Meraki branch IPsec tunnel to the NGFW hub

Run: `node tools/health-agent.mjs --config=my-config.json --until=10`

- [ ] **HC-10-IKE** Both ends use IKEv2
- [ ] **HC-10-PEERS** Each end points at the other's public address
- [ ] **HC-10-PSK** Pre-shared key is a matching secret-store reference, not a literal
- [ ] **HC-10-NETS** Tunnel carries the branch LAN and the VIP only
- [ ] **HC-10-ZONE** Tunnel interface is in the vpn-branch zone

## Stage 11: Branch policy and routing

Run: `node tools/health-agent.mjs --config=my-config.json --until=11`

- [ ] **HC-11-FW** Branch firewall allows tcp/443 to the VIP only and denies other data center traffic
- [ ] **HC-11-RETURN** NGFW routes the branch LAN back through the tunnel
- [ ] **HC-11-ISOLATION** Only the dmz zone may reach the app zone, so the F5 is the sole path to the pool

## Stage 12: End-to-end validation

Run: `node tools/health-agent.mjs --config=my-config.json --until=12`

- [ ] **HC-12-RESULTS** All seven validation checks are recorded as pass
- [ ] **HC-12-NOFAIL** No validation result is anything other than pass
- [ ] **HC-12-ENFORCED** WAF is enforcing, not logging only
