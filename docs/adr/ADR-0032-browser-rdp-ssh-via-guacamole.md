# ADR-0032: Browser RDP/SSH/VM-console via Apache Guacamole

**Status:** Accepted (8 September 2026)

## Context

`05-CONTROL-PLANE.md` assumed operators reach servers with an RDP client over the admin VPN. That means: a VPN client on every laptop, credentials typed into `mstsc`, shared or LAPS-retrieved local admin passwords, standing access, and **no record of what anyone did inside the session**. For a platform whose whole security case rests on "no long-lived credentials" and "evidence, not assurance", that is the largest remaining hole. The owner's requirement is explicit: RDP and everything else controlled from the web interface.

AWS itself has no answer here. Session Manager is text-only.

## Options

(a) RDP client over VPN (status quo assumption). (b) Windows Admin Center's built-in RDP tool. (c) **Apache Guacamole** as a gateway inside the console. (d) A commercial PAM product (CyberArk, Delinea).

## Decision

(c). Apache Guacamole (Apache-2.0), which is a clientless remote desktop gateway supporting VNC, RDP and SSH, with the client delivered as an HTML5 web application so access is not tied to any device or location. Deployed as `guac-01` (a Linux VM: a **third Linux exception**, amending ADR-0003) running `guacd` plus the client, embedded in the Argus Console's Connect tab and never exposed as its own UI.

Session mechanics are mandatory, not optional:

1. Role and tier checked by the console API; elevation requested inline if absent, with a reason and an approver.
2. OpenBao issues a **one-time credential** scoped to that VM and session length. Guacamole receives it directly over the internal channel; **the operator never sees or types a password**.
3. Session recording (full screen video plus keystroke timeline) written to the object-locked `argus-sessions` bucket, retained 400 days.
4. Clipboard and file transfer gated by role; every transfer logged with a SHA-256.
5. Automatic expiry closes the session and revokes the credential.
6. `guac-01` is reachable only from the console's identity, never directly.

## Why

Guacamole's session recording, clipboard control, file transfer and LDAP/AD authentication are built in, and it is the only mature open-source option that covers RDP, SSH and VNC in one gateway. Combined with OpenBao's dynamic credentials it turns remote access from the platform's weakest control into one of its strongest: better than the AWS capability it replaces, not merely equal.

Option (b) is Windows-only, unrecorded by default, and dies with ADR-0033. Option (d) costs more than the rest of the platform's software combined.

## Consequences

- A third Linux VM to patch, in Tier 1, covered by Wazuh, IPsec (strongSwan) and backups. ADR-0003 is amended from two exceptions to three; a fourth still needs its own ADR.
- `argus-sessions` is added to `storage/buckets.yaml` with a 400-day object lock; recordings are large: budget ~1 GB per hour of RDP.
- Recording people's sessions is a workplace matter, not only a technical one: the team is told plainly, the red recording banner is always visible, and the retention period is written down. Nobody is recorded secretly.
- Guacamole must be validated on the day-one lab alongside Service Fabric and SeaweedFS; it becomes assumption **A11** in `09-VALIDATION-STATUS.md`.
- The admin VPN remains for PAW and management-plane access; it is no longer needed for routine server work.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
