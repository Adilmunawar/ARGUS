# Phases and runbooks

Each phase has an exit gate. A phase is not "done" when its tasks are finished; it is done when the gate is passed and the report is committed to `docs/runbooks/drills/`.

## Phase 0 — Foundation (weeks 1–6)

| Week | Work | Owner |
|---|---|---|
| 1 | Procure Tier 1 (`07-HARDWARE-AND-LICENSING.md`). Rack, cable, label. IPMI on MGMT VLAN. UPS + NUT. OPNsense pair: WAN, VLANs, WireGuard admin VPN, default-deny. Two PAWs issued with FIDO2 keys. | platform |
| 2 | Windows Server 2025 Datacenter Server Core on `hv-01..03` (from a signed, hash-pinned ISO via WDS on `wac-01`); Secure Boot, TPM, BitLocker TPM+PIN. `dc-01`, `dc-02` as VMs on `hv-01`/`hv-02` (temporarily unclustered); forest `argus.local`; DNS; sites and subnets. | platform |
| 3 | Failover Cluster `argus-hvc-a` + S2D (mirror-accelerated parity, ReFS, CSVs); file-share witness placeholder; `ca-root-01` offline root created and powered off; `ca-issuing-01`; auto-enrolment GPOs; `hgs-01`; Shielded VM templates; Hyper-V SET switches with VLAN trunks; RoCE PFC/ECN on the switch. **Test: pull a node's power.** | platform |
| 4 | `sf-01..05` VMs (Server Core, Shielded); Service Fabric standalone cluster with X.509 (AD CS) security; `openbao` ×3 (Raft, Shamir 3-of-5 — keys to three named people, ceremony recorded); AD auth method; first policies. `gmsa-*` accounts per `identity/gmsa.yaml`. IPsec domain isolation GPO in **request** mode. | platform |
| 5 | Caddy ×2 with ACME via proxy; NATS ×3; Garnet ×2; Prometheus/Loki/Grafana/OTel/Alertmanager/Apprise; `windows_exporter` everywhere; `wef-01` + Sysmon GPO; `siem-01` (Ubuntu, Wazuh); WSUS on `wac-01`; Windows Admin Center behind AD FS. WDAC in **audit** mode with the base policy. | platform + security |
| 6 | `runner-01/02` (GitHub self-hosted), code-signing template, `signtool` pipeline; `forgejo-01` mirroring the repos; `argus-gitops` created; reconciler v0 (SF apps only); hello-world SF app deployed by PR. Egress proxy allow-list live; default route removed from PLATFORM/DATA. | platform |

**Exit gate:** power-pull a host → no user-visible impact (there are no users yet; the test is the SF hello-world stays healthy and the DC on that host fails over). `git push` → hello-world deployed in < 10 min. WDAC audit log shows zero unexpected binaries after a week. Wazuh reports 100 % agent coverage. Three people can each demonstrate unsealing OpenBao with their share.

## Phase 1 — Storage and backups (weeks 7–10)

SeaweedFS ×3 (Site A) with volumes on the S2D capacity tier; buckets per `storage/buckets.yaml` with object lock on `argus-backups` and `argus-artifacts`; S3 endpoint behind Caddy with AD CS TLS; per-app S3 credentials from OpenBao. `rclone` migration of the 1.16 M survey pictures (from the AWS box's `D:\SurveyStorage*` and `C:\IIS_Deployments\TempLocationSurvey`) and the raster archive — seeded by physical disk if faster. SQL backups from the **AWS** `sql` box to `argus-backups` over WireGuard (site-to-AWS tunnel for the migration window). Kopia repository for pictures. Site B minimum: `hv-b01`, `dc-03`, `sw-b01` (lock 90 d), witness, Uptime Kuma. SeaweedFS replication A → B.

**Exit gate:** every backup exists at both sites, object-locked; **restore drill #1**: rebuild `umairv3_db` at Site B from the B copy, time it, sign the report; `zd-daily-db-backups` on AWS set read-only; `RESTORE VERIFYONLY` green for 14 consecutive days.

## Phase 2 — Mills cutover (weeks 11–16)

`sql-01` VM (Shielded, NVMe-tier CSV, TDE) restored from the Phase 1 backup and kept in sync by log shipping from AWS until cutover night. Mills API/Web/Gateway as SF guest executables (`apps/mills/app.yaml`), Garnet replacing the in-process caches (code change: `IMemoryCache` → `IDistributedCache`, three files), NATS-triggered Functions for ingest/export/AI, timer Function for the hourly precompute. AD FS OIDC for the web login (API accepts both token types). `legacy-landsurvey-01` VM lifted from AWS. `mills.zaraatdost.pk` on Caddy; `zdost.aoserv.com:8443` redirects for 90 days. **Cutover night:** freeze writes, final log restore, repoint the mobile apps' DNS *only if* Phase 4's name is already in the apps — otherwise the apps keep hitting AWS SQL, which becomes a **read-only mirror is not possible** → decision: mobile apps keep writing to AWS SQL until Phase 4, and Mills dashboard reads from the Argus replica via AG *(see `08-OPEN-QUESTIONS.md` Q6)*. Secrets rotation (Mills D16): new SQL logins via OpenBao, `sa` disabled, all third-party keys into `kv/mills/*`. OTel in the API and web; Grafana "Mills" folder; alert rules.

**Exit gate:** 14 days at ≥ 99.9 % served from Site A; p95 < 300 ms; EC2 is warm standby (still receives log shipping); the first WhatsApp alert has been received and acknowledged by on-call.

## Phase 3 — ML and geospatial (weeks 15–24, overlaps)

`gpu-01`: Ubuntu, NVIDIA driver + CUDA, AD join (SSSD), strongSwan IPsec, Wazuh, Ray (head + workers), MLflow (backend `argus_ml`, artefacts `argus-ml`), Dagster (Postgres storage), JupyterHub (AD FS). `pg-01` with PostGIS and pgstac. Sentinel mirror Dagster job; TiTiler, Martin, STAC API, self-hosted OpenRouteService as SF apps. Port the v5 classifier to Dagster assets (feature-table build first, since it is the slow part in Colab); SegFormer and HRNet as Ray Train jobs; boundary vectorisation as Ray tasks; harvest-detection sensor. Ray Serve endpoint for the classifier behind Caddy.

**Exit gate:** one full season's `v5_train_table` regenerated on-prem and matching the Colab output within tolerance; SegFormer epoch time on the L40S beats the current best; Mills map served from Martin/TiTiler with first paint < 500 ms on the office link; ORS quota alerts gone.

## Phase 4 — Database and mobile apps (weeks 20–30)

Requires **Q6** answered. Mobile app release with the new endpoint name (`api.zaraatdost.pk`) and certificate pinning; adoption tracked in Grafana from Caddy logs. SQL Always On: `sql-01` primary, `sql-02` (Site B) async secondary; reporting queries (dashboard summaries, Grafana SQL panels) moved to `sql-02`. When app adoption > 95 %: AWS SQL becomes read-only, a TCP forwarder on the old IP relays stragglers to `sql-01` for 60 days. First PostGIS migrations for additive tables per Mills OPEN-DECISIONS rulings. AGIS: Firebase Auth → AD FS, Firestore → `argus_geo`. ADR-0031 (FULL recovery) executed on the owner's ruling.

**Exit gate:** zero connections to the AWS IP for 30 days (Caddy/forwarder logs); AWS SQL box powered off for 30 days with no incident; AG healthy with < 5 s lag.

## Phase 5 — DR and the AWS exit (weeks 28–34)

Site B to full spec (`hv-b02`, `pg-02` streaming replica). Hyper-V Replica for every VM with a Site B copy. **DR drill #1:** at a planned hour, cut the Site A WAN and power; bring `sql-02` to primary, fail over Hyper-V Replica VMs, promote `pg-02`, repoint DNS; measure; fail back. AWS: snapshot the EC2 AMIs and the bucket to `argus-backups/aws-final/`, delete, close the account.

**Exit gate:** DR drill RTO ≤ 8 h with a signed report; AWS invoice $0.

## Phase 6 — Hardening and audit (weeks 34–40)

WDAC audit → **enforced**, host by host, catalogues complete. Always Encrypted on CNIC/phone columns. External penetration test (external + assumed-breach). PingCastle/Purple Knight AD review to green. Console at parity with WAC for daily operations (Hosts & VMs, Runbooks screens). Evidence pack v1 generated. Backstage-style service catalogue *not* built — the console's Applications screen is the catalogue.

**Exit gate:** pen-test critical/high findings closed; WDAC enforced on 100 % of production hosts; evidence pack produced from the platform.

## Runbooks (`docs/runbooks/`)

Each is a Markdown file with a parameter block the console renders as a form and a `steps:` section of JEA-scoped PowerShell (or `argus` calls) executed with a transcript. Initial set:

| Id | Runbook | Trigger |
|---|---|---|
| `hv-01-drain-node` | Live-migrate VMs off a host for maintenance | patch window |
| `hv-02-node-loss` | What to check when a host drops | cluster event |
| `sql-01-restore-drill` | Restore latest full+diff+log to `sql-drill-01`, run consistency checks, time it, produce report | monthly |
| `sql-02-ag-failover` | Planned/forced AG failover to Site B | DR, incident |
| `sw-01-bucket-lock-audit` | Verify object-lock and replication on `argus-backups` | weekly |
| `sf-01-app-rollback` | Roll an SF app back to the previous version | deploy failure |
| `ob-01-unseal` | OpenBao unseal ceremony (3 key holders) | after restart |
| `ob-02-rotate-lease` | Revoke and reissue dynamic credentials for an app | suspected leak |
| `sec-01-suspected-compromise` | Quarantine a host, preserve evidence, page security | Wazuh critical |
| `sec-02-credential-leak` | Revoke leases, rotate gMSA, invalidate sessions, audit | leak |
| `sec-03-ransomware` | Freeze bucket writes, isolate, begin Site B restore | detection |
| `dr-01-site-a-loss` | Full failover to Site B | quarterly drill / disaster |
| `pwr-01-ups-shutdown` | Ordered shutdown at 20 % UPS | NUT |
| `cert-01-renewal-failure` | Caddy/AD CS certificate renewal failed | alert |
| `ml-01-gpu-node-rebuild` | Reprovision `gpu-01` from IaC | failure |
| `net-01-vpn-lockout` | Regain admin access if the VPN is down (console cable on MGMT, PAW) | lockout |

`docs/runbooks/drills/` holds every signed drill report; the evidence pack links to them.
