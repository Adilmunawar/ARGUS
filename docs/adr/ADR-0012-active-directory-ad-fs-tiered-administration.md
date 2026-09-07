# ADR-0012 — Active Directory + AD FS; tiered administration

**Decision.** A new forest `argus.local` (two DCs at Site A, one at Site B); **AD FS** for OIDC/SAML to the console, Grafana, Windows Admin Center, JupyterHub and the Mills web login; **Windows Hello for Business / FIDO2** for humans; **gMSA** for every service; **LAPS**; **Tier 0/1/2** admin model with Privileged Access Workstations; **JEA** endpoints for operators; NTLM disabled; LDAP signing and channel binding enforced.

**Why.** Included in the Windows licence, the most mature identity system available, and the foundation every other Windows security control (Kerberos-authenticated IPsec, gMSA, Credential Guard) assumes. Keycloak was the Linux plan's choice; on Windows it would duplicate AD.

**Consequences.** The Mills mobile apps keep their HMAC login (ADR-0030); AD FS fronts only the web.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
