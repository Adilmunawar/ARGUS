---
id: boot-01-day-one
title: Day one, from zero to a validated decision, on hardware you already have
tier: 1
approval: none
---

## When

Before any hardware is bought. The purpose is to falsify the riskiest assumptions (A1, A2, A3 in `09-VALIDATION-STATUS.md`) for a few hundred dollars instead of $85-110k.

## Preconditions

One spare machine; a workstation, an old server, even a well-specified desktop: 8+ cores, 64 GB RAM, 1 TB SSD, virtualisation enabled in BIOS, TPM 2.0 if available. A Windows Server 2025 evaluation ISO (180 days, free). A restored copy of `umairv3_db`: never production.

## Steps

### 1. Base host (day 1)
Install Windows Server 2025 **Datacenter evaluation**, Desktop Experience for now. Enable Hyper-V, Failover Clustering (single node), Windows Admin Center. Confirm Secure Boot and TPM in `msinfo32`. This host stands in for `hv-01`.

### 2. Domain (day 1)
VM `dc-01`, 2 vCPU / 4 GB. Promote to a new forest `arguslab.local`. This is a throwaway forest: do not name it `argus.local` yet.

### 3. **Test A1: Service Fabric** (day 2, the single most important test)
Three VMs `sf-01..03`, 4 vCPU / 8 GB, domain-joined. Download the current Service Fabric standalone package for Windows Server. Run `TestConfiguration.ps1` against a 3-node `ClusterConfig.json`, then `CreateServiceFabricCluster.ps1`. Open Service Fabric Explorer.

**Pass:** the cluster forms, all nodes healthy, and you can deploy a guest executable; package the Mills API's `dotnet publish` output as an `.sfpkg` and deploy it. **Fail (package unavailable, unsupported on Server 2025, or guest-exe deployment fights you):** stop. ADR-0005 is wrong; try Nomad on the same three VMs, and if that also fails, the platform becomes WinSW services driven by the reconciler. **Record the outcome in `docs/adr/` as an amendment either way.**

### 4. **Test A2: SeaweedFS on Windows** (day 2)
On the host: run `weed server -s3 -dir=D:\seaweed` as a WinSW service. Then, against it, run in order: the .NET `AWSSDK.S3` client with a 5 MB and a 5 GB object; `rclone copy` of 50,000 small files; `kopia repository create --s3`; `wal-g backup-push`. **Pass:** all four work, including multipart and object-lock (`weed s3 -config` with WORM). **Fail:** SeaweedFS moves to a Linux VM, which is a third Linux exception and needs an ADR.

### 5. **Test A3: the database** (day 3)
VM `sql-lab`, 8 vCPU / 32 GB, SQL Server 2022 **Developer** (free). Restore the `umairv3_db` copy. Run the heaviest real procedures: `GetLHStatisticsNew` (5 result sets), the hourly stage-and-swap precompute, a map-geometry query. Compare timings against the AWS box. **Pass:** results identical, timings comparable or better. **Fail:** note exactly which procedure and why; it changes the Phase 2 estimate.

### 6. Wire the Mills stack end to end (day 3-4)
Deploy `MillsApi`, `MillsWeb`, `MillsGateway` from `platform/gitops/apps/mills/app.yaml` onto the lab Service Fabric cluster, pointed at `sql-lab` and lab SeaweedFS. Put Caddy in front. Sign in, load the dashboard, open a map page, run the loans ledger: the first-boot checklist from the Mills repo's own `DEPLOYMENT.md`.

### 7. Prove the loop (day 4-5)
Stand up OpenBao (single node, dev-ish but real Raft), put `Jwt__SigningKey` in it, inject it at start. Create a throwaway GitOps repo. Write **just enough reconciler**, one PowerShell script is fine at this stage, that reads a version from YAML and runs `Start-ServiceFabricApplicationUpgrade`. Change the version in Git, watch it deploy.

### 8. Measure and write it down
Record: cluster form time, deploy time, dashboard p95, the four SeaweedFS results, procedure timings, anything that fought you. Commit as `docs/runbooks/drills/2026-09-XX-boot-01-day-one.md`.

## Verification

The lab passes if a `git push` deploys the real Mills dashboard, backed by the real database and real object storage, on Windows, with no AWS involved, and you can say how long each step took.

## Rollback

There is nothing to roll back; it is a lab. Wipe it.

## Report

Update `docs/09-VALIDATION-STATUS.md`: move A1, A2, A3 out of *Assumed* into *Verified* or into a new ADR that changes the design. **Only after this report is committed should hardware be ordered**: the lab may change what you buy.
