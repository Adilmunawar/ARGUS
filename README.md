<div align="center">

# Argus

**A sovereign, Windows-first private cloud: the complete design record for replacing AWS with hardware you own.**

[![validate](https://github.com/Adilmunawar/argus/actions/workflows/validate.yml/badge.svg)](https://github.com/Adilmunawar/argus/actions/workflows/validate.yml)
[![console tests](https://img.shields.io/badge/console%20tests-163%2F163-046c4e)](platform/console/prototype/tests/run-tests.js)
[![ADRs](https://img.shields.io/badge/ADRs-34-1e6f4a)](docs/01-DECISIONS.md)
[![licence](https://img.shields.io/badge/licence-MIT-113a2b)](LICENSE)
[![status](https://img.shields.io/badge/status-planning%20%C2%B7%20v0.6.1-b07f23)](CHANGELOG.md)

</div>

---

Most "leave the cloud" write-ups are opinion pieces. This is the working record of an actual migration: thirty-four architecture decisions with the options weighed and the costs named, every application traced down to its service account and backup, a security architecture rooted in hardware, a hardware bill of materials, and a web console designed against AWS Cloudscape, Google Cloud and the Azure portal, with a tested prototype you can open in a browser.

It also says plainly what has **not** been proven. `docs/09-VALIDATION-STATUS.md` grades every claim as verified, grounded, reasoned or assumed, and lists the eleven assumptions most likely to be wrong. Read that before trusting anything else here.

## At a glance

| | |
|---|---|
| **Replaces** | EC2, S3, RDS, Cognito, IAM, Secrets Manager, KMS, Lambda, SQS/SNS, ElastiCache, CloudWatch, X-Ray, ECR, CodePipeline, SageMaker |
| **Base** | Windows Server 2025 Datacenter · Hyper-V · Failover Clustering · Storage Spaces Direct · Service Fabric · Active Directory |
| **Security** | Hardware root of trust, WDAC code integrity, IPsec domain isolation, no standing admin rights, object-locked backups at two sites |
| **Control** | Web console (.NET 10 + Next.js) · `argus` PowerShell module and CLI · a GitOps repository that is the only writer of production |
| **Targets** | RPO 15 min · RTO 8 h for full site loss · 99.9% · under 10 min from `git push` to signed production deploy |
| **Exceptions** | Three Linux hosts, each justified by an ADR: the GPU node, the Wazuh SIEM manager, the Guacamole gateway. OPNsense appliances are not counted, being appliances rather than servers. |
| **Owner** | Adil Munawar, ML Research & Development |
| **Status** | Planning · v0.6.1 · 8 September 2026 |

## Start here

1. [`docs/00-MASTER-PLAN.md`](docs/00-MASTER-PLAN.md): what we are building, the targets, the phases.
2. [`docs/01-DECISIONS.md`](docs/01-DECISIONS.md): **why** every component was chosen, what it replaces, what was rejected. Every future change to the platform starts as a new ADR here.
3. [`docs/02-APPLICATION-INFRASTRUCTURE-MAP.md`](docs/02-APPLICATION-INFRASTRUCTURE-MAP.md): every application, down to the service account, bucket, port and backup that carries it.
4. [`docs/03-SECURITY-ARCHITECTURE.md`](docs/03-SECURITY-ARCHITECTURE.md): the controls, the threat model, the evidence.
5. [`docs/04-NETWORK-AND-SITES.md`](docs/04-NETWORK-AND-SITES.md): zones, VLANs, addressing, the two sites.
6. [`docs/05-CONTROL-PLANE.md`](docs/05-CONTROL-PLANE.md): the console, the CLI, the GitOps flow.
7. [`docs/06-PHASES-AND-RUNBOOKS.md`](docs/06-PHASES-AND-RUNBOOKS.md): the schedule with exit gates; `docs/runbooks/` for the operational procedures.
8. [`docs/07-HARDWARE-AND-LICENSING.md`](docs/07-HARDWARE-AND-LICENSING.md): bill of materials, Windows and SQL licensing.
9. [`docs/08-OPEN-QUESTIONS.md`](docs/08-OPEN-QUESTIONS.md): decisions still needed from the owner.
10. **[`docs/09-VALIDATION-STATUS.md`](docs/09-VALIDATION-STATUS.md): what is actually tested and what is not. Read this before trusting any of the above.**
11. [`docs/10-CONSOLE-DESIGN.md`](docs/10-CONSOLE-DESIGN.md): the web console, every screen including browser RDP. Open [`platform/console/prototype/index.html`](platform/console/prototype/index.html) in a browser to see it.
12. [`docs/11-CONSOLE-UX-BENCHMARK-AND-BUGS.md`](docs/11-CONSOLE-UX-BENCHMARK-AND-BUGS.md): AWS/GCP/Azure benchmark, the test suite, every bug found and the fix plan. `node platform/console/prototype/tests/run-tests.js`: currently 163/163.

## Before you buy anything

Run [`docs/runbooks/boot-01-day-one.md`](docs/runbooks/boot-01-day-one.md): a five-day lab on one spare machine that tests the three assumptions most likely to be wrong. It costs a Windows evaluation licence and a week. Ordering hardware first risks $85-110k against an untested design.

## Repository layout

```
docs/               the plan (read these first)
docs/adr/           one file per architecture decision, numbered
docs/runbooks/      operational procedures, one per failure or task
platform/console/   Argus Console (.NET 10 API + Next.js), the web control surface
platform/cli/       Argus PowerShell module + argus thin CLI
platform/gitops/    desired state of the platform: apps, VMs, buckets, secrets refs, policies
platform/policies/  WDAC, GPO baselines, firewall/IPsec and Wazuh rules; enforced and versioned
platform/iac/       OpenTofu (Hyper-V provider) + DSC v3 for hosts and VMs
CHANGELOG.md        every change to the plan, dated, with the reason
```

## How changes happen

Nothing about this platform changes without a commit here. A new component, a removed one, a changed port, a rotated key policy: it is an ADR (`docs/adr/`), a line in `CHANGELOG.md`, and a change in `platform/`. `git log` is the history of why the platform is the way it is.

## Try the console

```bash
open platform/console/prototype/index.html          # no build, no server, no network

npm ci && npx playwright install chromium           # once
node platform/console/prototype/tests/run-tests.js  # 163 assertions in headless Chromium
```

The console is static, but it works: ten sections, a command palette, sortable and token-filtered tables, recorded browser RDP in a drawer that survives navigation, just-in-time elevation with a countdown, and the reconciler's plan and blast radius shown before any change is approved.

The tests are real too. 19 suites in headless Chromium against the rendered DOM: axe-core WCAG 2.1 A/AA on every screen and every overlay, keyboard traversal with actual `Tab` presses including focus trapping and restoration, contrast computed from rendered pixels, six viewport widths, WCAG 1.4.10 reflow at 200% and 400% zoom, a density suite that asserts a 1366×768 laptop does not spend more than 55% of its screen on chrome, a layout suite that catches a stylesheet rule leaking into a table cell, and a security pass that reads the source to prove `innerHTML` appears nowhere.

## Relationship to other repos

- `Zarz001/Mills-Restructured-by-Zayan`: the first application to land on the platform (Phase 2).
- `adilmunawar/ZD-claude-plugin`: the team's Claude Code plugins; `zd-deploy`, `zd-ops` and `zd-security` are pointed at `platform/gitops/` and `docs/runbooks/`.
- `Adilmunawar/ZaraatDost-Models`, `AdilMunawar/sugarcane`: the ML pipelines that move to the GPU node in Phase 3.
