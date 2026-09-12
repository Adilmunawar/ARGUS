# platform/gitops: desired state

This directory is the *template* of the private `ZaraatDost/argus-gitops` repository (ADR-0021/0023). Its `main` branch is production. Only the reconciler writes to systems; humans write here.

What CI enforces (`.github/scripts/check-gitops.py`): every `*.yaml`/`*.yml` under `platform/gitops/` and `platform/policies/` must parse, and every one that carries a top-level `kind` is validated against the schema in `schemas/` whose `kind` const matches it. A document whose `kind` has no schema is reported as uncovered and fails the check. Files with no `kind` (for example `apps/*/alerts.yaml`, which is Prometheus rule syntax) are parsed but not schema-checked, and `schemas/` itself is skipped. Schemas are JSON Schema 2020-12 and must compile under ECMA-262 regex rules, so that a JavaScript validator and the Python one agree.

Covered kinds today: `ServiceFabricApp`, `Environment`, `ServiceAccounts`, `BucketSet`, `IpsecRules`.

What CI does *not* check: that an app pinned in `environments/*.yaml` has a spec under `apps/`, that an identity named in `storage/buckets.yaml` or `policies/firewall/ipsec-rules.yaml` exists in `identity/gmsa.yaml`, or that a declared bucket matches the S3 identities in `platform/compose/`. Those are cross-file invariants; the bucket half of the last one is verified at boot by `platform/console/tools/init-object-storage.js`.

Other rules, enforced by review rather than by CI: `identity/` and `network/` and `policies/` need two Tier 1 approvals; secrets are never values, only OpenBao paths (`{{ openbao:kv/... }}`) — the `ServiceFabricApp` schema does enforce this for service `env`, where a secret-named key must hold an OpenBao reference; artefacts are referenced by SHA-256.
