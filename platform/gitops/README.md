# platform/gitops: desired state

This directory is the *template* of the private `ZaraatDost/argus-gitops` repository (ADR-0021/0023). Its `main` branch is production. Only the reconciler writes to systems; humans write here.

Rules: every file validates against `schemas/`; `identity/` and `network/` and `policies/` need two Tier 1 approvals; secrets are never values, only OpenBao paths (`{{ openbao:kv/... }}`); artefacts are referenced by SHA-256.
