# ADR-0030: Mobile-app password scheme frozen; AD FS fronts the web

**Status:** Accepted · **Date:** 2026-09-08

**Context.** A constraint of the Orders application: its passwords are HMAC-SHA512 in a legacy scheme shared with its mobile apps, and a rehash locks the apps out.

**Options.** (a) Adopt Keycloak for every login. (b) Rehash the mobile-app passwords and move every login to AD FS now. (c) Freeze the mobile-app scheme and put AD FS in front of the web only.

**Decision.** The Orders API keeps minting its own JWTs for the mobile apps. The web login moves to AD FS (OIDC) in Phase 2; the API accepts either token type, scoped by the same per-tenant authorisation checks. When the mobile apps next release, they adopt OIDC PKCE against AD FS and the HMAC table is frozen (no new writes).

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
