# Validation status: what is proven, what is not

Written 8 September 2026. **Read this before trusting anything in this repository.**

The plan was produced by design and research, not by building. The only environment available when it was written was a Linux sandbox with no Windows Server, no hardware, and no network access to Microsoft. Everything below is stated at the confidence it has actually earned.

## Confidence levels

| Level | Meaning |
|---|---|
| **Verified** | Executed and observed here |
| **Grounded** | Read from the actual source repo, vendor docs or release notes; not executed |
| **Reasoned** | Standard practice applied to this situation; no source consulted for this exact combination |
| **Assumed** | Believed true, not checked, the highest-risk category |

## Verified (the short list)

| Item | How |
|---|---|
| The Mills AWS surface is EC2 + one S3 bucket, with no AWS SDK in any manifest | grepped every `.cs`/`.csproj`/`.json`/`.ts`/`.tsx`/`.ps1`/`.yml`/`.md` in the uploaded repo |
| Mills solution layout, target framework `net10.0`, `output: "standalone"`, gateway's no-certificate branch, every config key used in `app.yaml` | read from the source |
| All 8 YAML/JSON files in `platform/` parse | `yaml.safe_load_all` / `json.loads` |
| `apps/mills/app.yaml` validates against `schemas/app.schema.json` | `jsonschema.validate` |
| The schema's inline-secret rule actually rejects a `password=` value in `env` | negative test: injected a bad value and confirmed the failure |

## Grounded, not executed

Component choices and their licence/status facts: SeaweedFS (Apache-2.0, Windows build, small-object design), MinIO community edition archived Feb 2026, OpenBao MPL-2.0 with v2.6 in Aug 2026, Garnet MIT and RESP-compatible, Service Fabric MIT, Cozystack v1.6.0 (superseded plan). The Mills repo's own constraints; D22 old-host dependency, D16 secrets in git history, D14/SIMPLE recovery, the HMAC password scheme shared with the mobile apps, `MultipleActiveResultSets=False`: are quoted from its documents.

## Reasoned: the whole architecture

The topology, VLAN plan, IPsec identity rules, tier model, WDAC approach, backup regime, phase order and exit gates are standard practice applied to your situation. They are defensible but unproven **as a combination**.

## Assumed: the risk register

These are the things most likely to be wrong, in the order they will bite:

| # | Assumption | If wrong |
|---|---|---|
| A1 | Service Fabric standalone on Windows Server 2025 is current and supported for new clusters | ADR-0005 collapses → fall back to Nomad or a WinSW supervisor + the reconciler |
| A2 | SeaweedFS's Windows build is production-viable and its S3 surface satisfies the .NET SDK, `rclone`, Kopia and `wal-g` | ADR-0007 changes → SeaweedFS on a Linux VM (a third exception) or Ceph |
| A3 | `umairv3_db`'s stored procedures work unchanged on a restored copy in a Shielded VM | Phase 2 slips; some procs may need work |
| A4 | Shielded VMs + HGS do not interfere with SQL Server performance or Hyper-V Replica | drop shielding for `sql-01`, keep BitLocker |
| A5 | WDAC can be made to allow every third-party binary here via catalogues without breaking them | WDAC stays in audit mode longer than Phase 6 |
| A6 | Hardware prices and licence prices in `07-...` are within ±25 % for Pakistan | budget is wrong: get quotes first |
| A7 | The Colab-built v5 feature table reproduces on `gpu-01` within tolerance | Phase 3 gate slips |
| A8 | A 100 Mbps site link carries the steady-state replication | Site B lags; needs more bandwidth |
| A9 | `.NET 10` / SQL Server 2022 / Windows Server 2025 version combination has no blocking incompatibility | version pin changes |
| A10 | The reconciler is ~2,000 lines of C# | it is the platform's single point of failure; budget more |
| A11 | Guacamole's RDP recording, AD auth and OpenBao-injected one-time credentials work together on Windows Server 2025 targets | ADR-0032 weakens to recorded-but-password-typed, or to WAC's RDP; test it in the day-one lab |

## Not built at all

The reconciler, every console screen and API endpoint beyond `/health`, every runbook body, the WDAC base policy, the GPO baselines, the Wazuh rule packs, the OpenTofu `shielded-vm` module, every DSC resource named `Argus/*`, the CI signing pipeline. The files that exist are **specifications in executable formats**, not working code.

## What would change this document

Phase 0's exit gate is the first real test. After it, this file is rewritten with what actually happened, including the assumptions that turned out wrong. That rewrite is more valuable than the original plan.
