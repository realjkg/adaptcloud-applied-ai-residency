---
id: 04
title: F5 pool and health monitor
vendor: F5 BIG-IP (Local Traffic Manager)
requires: addressing.plan
produces: f5.pool
---

## Why this comes here

A virtual server is only as useful as the pool behind it. Build the pool and its health monitor first, so the virtual server in stage 06 has something healthy to send traffic to. A monitor also keeps traffic away from a dead member instead of letting users find out.

## Components involved

`f5-self` (10.20.0.10, the BIG-IP self-IP in the DMZ) and the application members `app-01` (10.30.0.11) and `app-02` (10.30.0.12).

## Configure (conceptual)

1. Create a health monitor of type HTTP, sending `GET /health` and expecting a 200 response, with an interval and timeout suited to the application. The send string must end with a carriage return and line feed, or the monitor fails.
2. Create a pool, attach the monitor, and add the two members on port 8080, which is the port the application listens on in this twin.
3. Set the load-balancing method (round robin is enough for the lab) and a member priority if one member should be preferred.
4. Do not create a virtual server yet.

## Verify

- Both members show as available in the pool.
- Stop one member in the synthetic app (or change its health path) and confirm the monitor marks it down and removes it from rotation.
- Restore the member and confirm it returns.

## If you do it out of order

Stage 06 references `f5.pool` as its destination. If the pool does not exist, the virtual server would point at nothing, and clients would see errors that look like a firewall problem. The twin refuses stage 06 until the pool exists.
