---
id: 06
title: F5 virtual server with TLS termination
vendor: F5 BIG-IP (Local Traffic Manager)
requires: f5.pool, tls.certificate, pa.interfaces
produces: f5.vip
---

## Why this is the delivery point

The virtual server is the address that clients and the NGFW see for the application: `10.20.0.100:443`. It is where TLS ends, where the pool is chosen, and where the application is reached. Everything upstream of it is about getting packets to this address safely.

## Components involved

`f5-vip` (10.20.0.100:443), `f5-self`, `f5.pool` from stage 04, and the certificate from stage 05. The NGFW's DMZ interface from stage 03 must be able to reach the address.

## Configure (conceptual)

1. Create a client SSL profile that references the certificate and key from stage 05, with a modern TLS version minimum (TLS 1.2 or later).
2. Create a virtual server with destination `10.20.0.100:443`, TCP protocol, the client SSL profile, and the pool from stage 04 as its default pool.
3. Enable source address translation (SNAT automap), so that return traffic from the pool comes back through the BIG-IP.
4. Attach the HTTP health monitor's behavior to the pool, not to the virtual server, so that the virtual server stays up while the pool shows reduced capacity.

## Verify

- The virtual server is available and shows the expected pool.
- A TLS handshake to `10.20.0.100:443` from the DMZ presents the expected certificate subject.
- Requests reach `app-01` and `app-02` alternately, and both return 200.

## If you do it out of order

Without the pool, the virtual server has no destination. Without the certificate, the client SSL profile cannot be built, so the twin would either serve plain HTTP on port 443 or show a handshake failure. Both are real mistakes that look like a working service in a dashboard. The twin refuses stage 06 until all three inputs exist.
