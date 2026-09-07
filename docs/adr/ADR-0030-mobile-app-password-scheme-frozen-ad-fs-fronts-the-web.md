# ADR-0030: Mobile-app password scheme frozen; AD FS fronts the web

**Context.** `DECISIONS.md` in the Mills repo: passwords are HMAC-SHA512, written and read in the legacy scheme, shared with the surveyor apps; a rehash locks the apps out.

**Decision.** The Mills API keeps minting its own JWTs for the mobile apps. The web login moves to AD FS (OIDC) in Phase 2; the API accepts either token type, scoped by the same `VendorId` guards. When the mobile apps next release, they adopt OIDC PKCE against AD FS and the HMAC table is frozen (no new writes).

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
