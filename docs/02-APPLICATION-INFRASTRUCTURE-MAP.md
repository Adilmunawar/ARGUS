# Application ↔ infrastructure map

Every application Zaraat Dost runs, traced down to the host, service identity, port, data store, bucket, secret, backup and alert that carries it. This is the document an on-call engineer opens at 3 a.m. It is generated from `platform/gitops/` in Phase 2 onward; until then it is maintained by hand and every change is a commit.

Conventions: `gMSA` names end in `$`; ports are TCP unless noted; "SF" = Service Fabric application; VMs are Shielded Generation 2 unless noted; zones are defined in `04-NETWORK-AND-SITES.md`.

---

## A. Hosts

### Site A

| Host | Role | Hardware | OS | Zone | Notes |
|---|---|---|---|---|---|
| `hv-01` … `hv-03` (→ `hv-05`) | Hyper-V + S2D cluster `argus-hvc-a` | 1U EPYC 32c, 256 GB, 2 × 3.84 TB NVMe (cache/OS), 4 × 20 TB HDD (capacity), 2 × 25 GbE RDMA, TPM 2.0, IPMI | Windows Server 2025 Datacenter, Server Core | MGMT 10, STORAGE 40 | Secure Boot, BitLocker TPM+PIN, WDAC, Credential Guard, HGS-attested |
| `gpu-01` | ML node | 2U EPYC 24c, 256 GB, 2 × L40S 48 GB, 4 × 3.84 TB NVMe, 2 × 25 GbE | Ubuntu 24.04 LTS | ML 50 | AD-joined (SSSD), strongSwan IPsec, Wazuh agent, no interactive SSH except from PAW via VPN |
| `hgs-01` | Host Guardian Service (attestation for Shielded VMs) | small 1U or a VM on a *separate* physical host | Windows Server 2025 | TIER0 11 | Must not run on the cluster it attests |
| `fw-a1`, `fw-a2` | OPNsense HA | 4 × 10 GbE x86 appliances | OPNsense 26.x | EDGE | CARP VIP; Suricata; WireGuard |
| `sw-a1` | Core switch | 48 × 25 GbE + 4 × 100 GbE | — | — | VLAN trunks to all hosts; RoCE v2 PFC/ECN for VLAN 40 |
| `ups-a1` | 10 kVA online UPS | — | NUT | MGMT 10 | NUT server on `wac-01`; graceful cluster shutdown at 20 % |

### Site B

| Host | Role | Notes |
|---|---|---|
| `hv-b01`, `hv-b02` | Hyper-V cluster `argus-hvc-b`; Hyper-V Replica target | same spec minus GPU; 6 × 20 TB each |
| `fw-b1`, `fw-b2` | OPNsense HA | WireGuard peer of Site A |
| `ups-b1` | 5 kVA UPS | |

## B. Virtual machines and Service Fabric nodes

| VM | Host cluster | vCPU / RAM / disk | Role | Identity | Zone | Backup |
|---|---|---|---|---|---|---|
| `dc-01`, `dc-02` | A | 4 / 8 GB / 100 GB | AD DS, DNS, KDC; FSMO on `dc-01` | — | TIER0 11 | System state daily; Hyper-V Replica off (DCs replicate themselves) |
| `dc-03` | B | 4 / 8 GB / 100 GB | AD DS, DNS; site link | — | TIER0 | as above |
| `adfs-01` | A | 4 / 8 GB / 80 GB | AD FS 2025; OIDC/SAML RP for every web UI; WHfB | `gmsa-adfs$` | TIER0 | Hyper-V Replica |
| `ca-root-01` | *offline* | 2 / 4 GB / 40 GB | AD CS offline root; powered off except for CRL signing | — | TIER0 (air-gapped) | Cold export in the safe |
| `ca-issuing-01` | A | 4 / 8 GB / 80 GB | AD CS enterprise issuing CA; auto-enrolment for machine, IPsec, code-signing templates | `gmsa-ca$` | TIER0 | Hyper-V Replica; CA key on HSM or TPM |
| `hgs-01` | separate | 4 / 8 GB | Host Guardian Service | — | TIER0 | Export of HGS keys in the safe |
| `sf-01` … `sf-05` | A | 8 / 32 GB / 200 GB | Service Fabric nodes (Server Core); `sf-01..03` seed | `gmsa-sf$` | PLATFORM 30 | Stateless by design — rebuilt from IaC |
| `sql-01` | A | 16 / 128 GB / OS 100 GB + data 2 TB NVMe-tier CSV + log 500 GB | SQL Server 2022 Standard, AG `argus-ag1` primary: `umairv3_db`, `FarmerFacilitatorDb`, `ArgusConsole` | `gmsa-sql$` | DATA 31 | Native backups every 15 min log / 6 h diff / 24 h full → `argus-backups`; Hyper-V Replica |
| `sql-02` | B | 16 / 128 GB / same | AG async secondary; readable for reporting | `gmsa-sql$` | DATA-B | Local copy of backups |
| `pg-01` | A | 8 / 64 GB / OS 100 GB + data 1 TB | PostgreSQL 17 + PostGIS 3.5: `pgstac`, `argus_geo`, `argus_ml`, `argus_console_events` | `gmsa-pg$` | DATA 31 | `pg_basebackup` nightly + WAL via wal-g → `argus-backups`; streaming replica on `pg-02` (B) in Phase 5 |
| `sw-master-01..03` | A | 4 / 16 GB / 100 GB + volume disks on S2D capacity tier (3 × 60 TB) | SeaweedFS master + volume + filer + S3 gateway, replication `001` | `gmsa-seaweed$` | DATA 31 | Volumes are the storage; `argus-backups` replicated to B |
| `sw-b01` | B | 4 / 16 GB / 100 TB | SeaweedFS replica; object lock 90 d on `argus-backups` | `gmsa-seaweed$` | DATA-B | — |
| `legacy-landsurvey-01` | A | 4 / 16 GB / 200 GB | The old LandSurveyApp API (IIS) — until Mills OPEN-DECISIONS D22 is retired | `gmsa-legacy$` | PLATFORM 30 (restricted) | Hyper-V Replica; weekly WSB |
| `siem-01` | A | 8 / 32 GB / 1 TB | Ubuntu; Wazuh manager + indexer + dashboard; Loki long-term index | `svc-wazuh` (AD, SSSD) | SEC 12 | Kopia of indexes → `argus-backups`; Hyper-V Replica |
| `wef-01` | A | 4 / 16 GB / 500 GB | Windows Event Forwarding collector; Grafana Alloy ships to Loki | `gmsa-wef$` | SEC 12 | Loki is the durable copy |
| `wac-01` | A | 4 / 8 GB / 80 GB | Windows Admin Center (AD FS login); NUT server | `gmsa-wac$` | MGMT 10 | Rebuilt from IaC |
| `runner-01`, `runner-02` | A | 8 / 32 GB / 300 GB | GitHub Actions self-hosted runners; `signtool` with code-signing cert from `ca-issuing-01`; egress only to allow-list | `gmsa-ci$` | BUILD 32 | Ephemeral; rebuilt weekly by IaC |
| `forgejo-01` | A | 4 / 8 GB / 500 GB | Forgejo mirror of all GitHub repos + Actions runner | `gmsa-forgejo$` | BUILD 32 | Kopia → `argus-backups` |
| `kuma-b01` | B | 2 / 4 GB | Uptime Kuma, status page | — | DMZ-B | — |

## C. Platform services (Service Fabric applications, system tenant)

| SF application | Instances | Port(s) | Identity | Depends on | Health probe | Alert |
|---|---|---|---|---|---|---|
| `Caddy` | 2 (cluster IP `10.30.0.10`) | 443/tcp+udp (HTTP/3), 80 → 443 | `gmsa-caddy$` | AD CS (internal), ACME (external via proxy), CrowdSec | `GET /healthz` 200 | 5xx > 1 % 5 min; cert < 14 d |
| `Nats` | 3 | 4222 client, 6222 cluster, 8222 monitor | `gmsa-nats$` | — | `/healthz` | JetStream stream lag > 1000 |
| `Garnet` | 2 | 6379 (TLS) | `gmsa-garnet$` | — | `PING` | memory > 80 % |
| `OpenBao` | 3 (Raft) | 8200 API, 8201 cluster | `gmsa-openbao$` | AD CS cert; unseal by 3 key holders | `/v1/sys/health` | sealed; lease failure |
| `Prometheus` | 1 (+1 B) | 9090 | `gmsa-prom$` | exporters | `/-/healthy` | target down |
| `Loki` | 1 | 3100 | `gmsa-loki$` | `argus-logs` bucket for chunks | `/ready` | ingest errors |
| `Grafana` | 2 | 3000 | `gmsa-grafana$` | AD FS OIDC, Prometheus, Loki, SQL (reporting on `sql-02`) | `/api/health` | — |
| `OtelCollector` | 2 | 4317 gRPC, 4318 HTTP | `gmsa-otel$` | Loki, Prometheus, Grafana traces | `/` | queue full |
| `Alertmanager` + `Apprise` | 2 | 9093, 8000 | `gmsa-alert$` | WhatsApp/Telegram/SMS gateway via egress proxy | `/-/healthy` | — |
| `ArgusConsoleApi` | 3 | 5200 | `gmsa-console$` | SQL `ArgusConsole`, OpenBao, Git (Forgejo), NATS, SF client API | `/api/v1/health` | 5xx; reconcile lag |
| `ArgusConsoleWeb` | 2 | 3200 | `gmsa-console$` | `ArgusConsoleApi` | `/` | — |
| `ArgusReconciler` | 1 stateful (3 replicas) | 5210 | `gmsa-reconciler$` | Git, SF client API, WMI to `hv-*`, SeaweedFS admin, OpenBao, DSC | SF replica health | desired ≠ actual > 15 min |
| `Titiler` | 2 | 8100 | `gmsa-geo$` | `argus-sentinel`, `pg-01` (pgstac) | `/healthz` | — |
| `Martin` | 2 | 3300 | `gmsa-geo$` | `pg-01` (`argus_geo`) | `/health` | — |
| `OpenRouteService` | 1 | 8082 | `gmsa-geo$` | OSM Pakistan graph on local disk | `/ors/v2/health` | — |
| `StacApi` | 2 | 8090 | `gmsa-geo$` | `pg-01` (pgstac) | `/` | — |

## D. Applications

### D.1 Mills Dashboard (`Zarz001/Mills-Restructured-by-Zayan`)

| Component | Runs as | Instances | Port | Identity | Talks to | Secrets (OpenBao path) | SLO |
|---|---|---|---|---|---|---|---|
| `MillsGateway` (YARP) | SF guest exe | 2 | 5140→ routes | `gmsa-mills$` | Caddy → this; `MillsApi`, `MillsWeb` | — (plain HTTP behind Caddy; cert-store lookup removed, ADR-0016) | 99.9 % |
| `MillsApi` (.NET 10) | SF guest exe | 3 | 5141 | `gmsa-mills$` | `sql-01` (Kerberos via gMSA, IPsec), Garnet, NATS, OpenBao (dynamic SQL creds), egress proxy → Anthropic, ORS (local), `legacy-landsurvey-01` | `kv/mills/jwt-signing-key`, `kv/mills/legacy-jwt`, `db/creds/mills-api` (1 h), `kv/mills/anthropic`, `kv/mills/ors` | p95 < 300 ms |
| `MillsWeb` (Next.js standalone) | SF guest exe | 2 | 3100 | `gmsa-mills$` | `MillsApi` (server-side via `MILLS_API_BASE`), egress proxy → Earth Engine | `kv/mills/ee-service-key` | — |
| Hourly precompute (`GetLHStatisticsNew` stage-and-swap) | Azure Functions host, timer trigger | 1 | — | `gmsa-mills-jobs$` | `sql-01` | `db/creds/mills-jobs` | must complete < 20 min |
| Shapefile ingest, exports, AI briefings | Azure Functions host, NATS trigger `argus.ingest.mills.*` | 2 | — | `gmsa-mills-jobs$` | `sql-01`, `argus-survey-pictures`, `argus-artifacts` | as above | queue age < 5 min |
| Survey images (`/map-qc/image`, 1.16 M files) | SeaweedFS `argus-survey-pictures` | — | S3 | `gmsa-mills$` (read), `gmsa-mills-jobs$` (write) | — | `s3/creds/mills-pictures` (30 d rotating) | — |
| Corporate survey pictures | SeaweedFS `argus-survey-pictures/corporate/` | — | S3 | as above | | | |
| Databases | `sql-01`: `umairv3_db` (main), `FarmerFacilitatorDb` (finance) | — | 1433 (IPsec, gMSA only) | `gmsa-sql$` | | | RPO 15 min |
| Legacy exports + geojson (D22) | `legacy-landsurvey-01` (IIS) via Caddy path `/legacy/*` | 1 | 443 | `gmsa-legacy$` | `sql-01` | `kv/legacy/*` | best effort |
| Web login | AD FS OIDC (Phase 2); API also validates | | | | | | |
| Mobile login | API-minted JWT, HMAC-SHA512 passwords (frozen, ADR-0030) | | | | | | |
| Backups | SQL native → `argus-backups/sql/umairv3_db/` (lock 35 d) → Site B (lock 90 d); Kopia of `argus-survey-pictures` → `argus-backups/kopia/pictures/` | | | `gmsa-backup$` (PUT only) | | | drill monthly |
| Observability | OTel traces gateway→API→SQL; Loki: SF logs; Prometheus: `windows_exporter`, `sql_exporter`, YARP metrics; Grafana "Mills" folder | | | | | | |
| Alerts | 5xx > 1 %; p95 > 1 s; precompute overrun; AG not synchronising; backup age > 30 min | | | | | | |

### D.2 Farmer loan app (`Zarz001/Zaraat-Dost-Loan-By-Zayan`)

| Component | Runs as | Notes |
|---|---|---|
| Loan API (.NET) | SF guest exe ×2, `gmsa-loan$` | `FarmerFacilitatorDb` on `sql-01`; Kibor/Salam ledgers; behind Caddy at `loans.zaraatdost.pk`; OTel; dynamic creds `db/creds/loan-api` |
| Mobile app (Expo) | phones | talks to `loans.zaraatdost.pk` via Caddy; certificate pinning to the Argus chain; repointed from AWS in Phase 4 |
| Applicant images | `argus-survey-pictures/loans/` | same bucket, own prefix, own S3 credential |

### D.3 AGIS (`Adilmunawar/AGIS`, Next.js + Firebase)

| Component | Runs as | Notes |
|---|---|---|
| AGIS web | SF guest exe ×2, `gmsa-agis$` | Firebase Auth → AD FS OIDC and Firestore → PostgreSQL `argus_geo` are Phase 4 migrations; until then Firebase stays external behind the egress proxy with keys in `kv/agis/firebase` |
| Map layers | Martin (vector tiles from `argus_geo`), TiTiler (rasters from `argus-sentinel`) | replaces per-page GeoJSON |

### D.4 ML pipelines (`Adilmunawar/ZaraatDost-Models`, `AdilMunawar/sugarcane`, `Model2`)

| Pipeline | Runs on | Orchestration | Inputs | Outputs | Identity |
|---|---|---|---|---|---|
| Sentinel mirror (S1 GRD, S2 L2A, Punjab/Sindh AOIs, daily) | `gpu-01` (CPU) | Dagster schedule → `eodag` → COG → `argus-sentinel`; pgstac insert; NATS `argus.sentinel.scene.landed` | Copernicus via egress proxy | `argus-sentinel/{s1,s2}/{tile}/{date}.tif`; STAC items | `svc-ml` (AD, SSSD); `s3/creds/ml-sentinel` |
| v5 land-use classifier (XGBoost; P00–P23 optical, M00–M23 radar, phenology) | `gpu-01` | Dagster assets: `parcels` → `s2_periods` → `s1_periods` → `phenology` → `v5_train_table` → `v5_model` → `parcel_predictions`; MLflow run per version (`v5.3` next) | `argus_geo.parcels`, `argus-sentinel`, GT tables in `argus_ml` | `argus_ml.v5_features`, `argus_ml.v5_predictions` (per season), model in MLflow → `argus-ml/models/v5/` | `svc-ml` |
| SegFormer-B5 land use (8 classes) | `gpu-01` (GPU) | Ray Train job from Dagster; checkpoints to `argus-ml/checkpoints/segformer/` | `argus-sentinel`, patches cache on local NVMe | prediction rasters → `argus-rasters/landuse/{aoi}/{season}.tif` | `svc-ml` |
| Sugarcane segmentation (UNet-CBAM, HRNet-W48) | `gpu-01` (GPU) | Ray Train; `final_finetune.py` becomes a Dagster op | as above | `argus-rasters/sugarcane/` | `svc-ml` |
| Boundary vectorisation (`boundary_to_polygons_ram_safe.py`) | `gpu-01` (CPU, Ray tasks per tile) | Dagster asset `parcel_polygons` | HRNet boundary rasters | `argus_geo.parcels_candidate` (PostGIS), QA in AGIS | `svc-ml` |
| Harvest detection (per-parcel NDVI drop) | `gpu-01` | Dagster sensor on `argus.sentinel.scene.landed` | `argus-sentinel`, `argus_geo.parcels` | `argus_ml.harvest_events` → Mills dashboard harvest pace | `svc-ml` |
| Inference endpoint (parcel classifier) | `gpu-01`, Ray Serve | behind Caddy at `ml.zaraatdost.pk/v5/predict`, AD FS-protected | | | `svc-ml` |
| Notebooks | `gpu-01`, JupyterHub | AD FS login; per-user GPU memory limits via Ray; `argus-ml` mounted | | | per user |
| Backups | MLflow DB (`argus_ml`) via wal-g; `argus-ml` and `argus-rasters` via Kopia (weekly, since they are reproducible); `argus-sentinel` **not** backed up (re-pullable) — documented exception | | | | `gmsa-backup$` |

### D.5 Zaraat Dost AI (inside Mills)

| Component | Notes |
|---|---|
| Anthropic API calls | from `MillsApi` only, via egress proxy, key `kv/mills/anthropic`, every prompt/answer to Loki (`argus.ai.audit`), 90-day retention |
| Fallback | vLLM on `gpu-01` serving an open-weights model behind the same interface; `Ai:Provider` switch in config; degraded quality, no external dependency |
| Evals | `tools/ai-evals/golden.json` run nightly by an Azure Function against both providers; results to Grafana |

### D.6 The console itself

See `05-CONTROL-PLANE.md`. Database `ArgusConsole` on `sql-01`; events in `argus_console_events` on `pg-01`; Git state in Forgejo (mirrored to GitHub `ZaraatDost/argus-gitops`, private).

## E. Data stores — summary

| Store | Engine | Host | Size (now → 3 y) | Owner identity | Backup | Lock |
|---|---|---|---|---|---|---|
| `umairv3_db` | SQL Server | `sql-01`/`sql-02` | ~600 GB → 1.5 TB | `gmsa-sql$` | 15 min log | — |
| `FarmerFacilitatorDb` | SQL Server | same | ~50 GB | | | |
| `ArgusConsole` | SQL Server | same | small | | | |
| `pgstac`, `argus_geo`, `argus_ml`, `argus_console_events` | PostgreSQL | `pg-01` | 200 GB → 2 TB | `gmsa-pg$` | WAL continuous | |
| `argus-survey-pictures` | SeaweedFS | `sw-*` | ~1.2 TB → 3 TB | `gmsa-seaweed$` | Kopia weekly + daily incremental | — |
| `argus-rasters` | SeaweedFS | | 2 TB → 10 TB | | Kopia monthly | |
| `argus-sentinel` | SeaweedFS | | 5 TB → 30 TB | | none (re-pullable) | |
| `argus-ml` | SeaweedFS | | 500 GB → 5 TB | | Kopia weekly | |
| `argus-artifacts` | SeaweedFS | | small | | replicated | WORM 365 d |
| `argus-backups` | SeaweedFS | A + B | 3.2 TB → 8 TB | `gmsa-backup$` (PUT) | is the backup | WORM 35 d (A), 90 d (B) |
| `argus-logs` | SeaweedFS | | 1 TB → 4 TB | `gmsa-loki$` | replicated to B | WORM 400 d |

## F. External dependencies

| Dependency | Consumer | Egress route | Credential | Failure behaviour |
|---|---|---|---|---|
| Copernicus Data Space | Sentinel mirror | proxy allow-list `*.dataspace.copernicus.eu` | `kv/ml/cdse` | mirror lags; pipelines use last scene |
| Google Earth Engine | `MillsWeb` crop monitoring | proxy allow-list `earthengine.googleapis.com` | `kv/mills/ee-service-key` | feature answers 503 (already coded) |
| Anthropic | `MillsApi` | proxy allow-list `api.anthropic.com` | `kv/mills/anthropic` | vLLM fallback |
| Let's Encrypt | Caddy | proxy | — | 90-day window; alert at 14 d |
| GitHub | runners, Forgejo mirror | proxy | fine-grained PAT in `kv/ci/github` | Forgejo runs CI |
| WhatsApp/Telegram/SMS gateway | Apprise | proxy | `kv/alerting/*` | email fallback via local SMTP |
| Windows Update / WSUS | all Windows | WSUS on `wac-01` | — | — |
