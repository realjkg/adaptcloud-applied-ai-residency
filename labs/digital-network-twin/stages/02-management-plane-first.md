---
id: 02
title: Management plane first
vendor: Palo Alto Networks (Panorama)
requires: addressing.plan
produces: mgmt.access-restricted
---

## Why this comes before data traffic

The management interface is the most valuable target in the network: whoever controls it controls every rule. Lock it down before you open any data path, so a mistake later in the sequence can't expose administration to the internet.

## Components involved

`panorama` (10.99.0.5) and the management interface on the Palo Alto NGFW. Management traffic stays in the `management` zone.

## Configure (conceptual)

1. Put the Panorama host in the `management` zone only, behind a data interface that carries an Interface Management profile.
2. On the dedicated MGT port, set Permitted IP Addresses to the administrator network. An empty list allows any source. On data interfaces, an Interface Management profile with a populated permitted list does the same job, and an interface with no profile denies management access.
3. Enable only HTTPS and SSH for management. Never enable HTTP or Telnet, and disable ping and SNMP unless monitoring requires them.
4. Require multi-factor authentication for administrators, or a separate authenticated jump path.
5. Confirm that no management address is reachable from the untrust zone.

## Verify

- An administrator on the permitted network can log in.
- A host on the untrust side cannot reach the management address on any port.
- The permitted-source list contains no `any`.

## If you do it out of order

If stage 03 is run before this stage, the NGFW's zones and interfaces can be created while management is still reachable from anywhere. A later rule mistake then gives an attacker a login page, not just a route. The twin refuses stage 03 until `mgmt.access-restricted` exists.
