<div align="center">

# Argus

### The blueprint for a sovereign private cloud that replaces AWS on hardware you own

**Windows Server · Hyper V · Service Fabric · Active Directory · GitOps · Zero Trust · Browser RDP**

[![validate](https://github.com/Adilmunawar/argus/actions/workflows/validate.yml/badge.svg)](https://github.com/Adilmunawar/argus/actions/workflows/validate.yml)
[![console tests](https://img.shields.io/static/v1?label=console%20tests&message=413%20passing&color=046c4e)](platform/console/prototype/tests)
[![architecture decisions](https://img.shields.io/static/v1?label=ADRs&message=34&color=1e6f4a)](docs/01-DECISIONS.md)
[![license](https://img.shields.io/static/v1?label=license&message=all%20rights%20reserved%20%C2%B7%20permission%20required&color=8a1c1c)](LICENSE)
[![version](https://img.shields.io/static/v1?label=version&message=v0.12.0&color=b07f23)](CHANGELOG.md)
[![GitHub stars](https://img.shields.io/github/stars/Adilmunawar/argus?style=social)](https://github.com/Adilmunawar/argus/stargazers)

[Why Argus](#why-argus) · [Features](#features) · [Quick start](#quick-start) · [Architecture](#architecture) · [Documentation](#documentation) · [Contributing](#contributing) · [License](#license)

</div>

> **This repository is not open source.** It is published so the design can be read and discussed. Using, copying, deploying, modifying or redistributing any part of it requires the written permission of Adil Munawar. See [License](#license).

<br>

Most "leave the cloud" articles are opinion pieces. **Argus is the working record of a real AWS exit**: thirty four architecture decision records with every option weighed and every cost named, each application traced down to its service account and backup, a security architecture rooted in hardware, a full bill of materials, and a web console benchmarked against AWS, Google Cloud and Azure, with a tested prototype you can open in your browser today.

It also says plainly what has **not** been proven. The [validation status](docs/09-VALIDATION-STATUS.md) grades every claim as verified, grounded, reasoned or assumed, and lists the eleven assumptions most likely to be wrong. Read it before trusting anything else here.

> ⭐ **If Argus saves you a week of research or a cloud bill, star the repository.** It helps other engineers planning a cloud exit find it.

## Why Argus

Cloud repatriation is now a mainstream decision, yet almost nothing public shows the full picture: identity, secrets, PKI, storage, queues, observability, backups, disaster recovery, licensing and the operator experience, all in one coherent design. Argus is that picture, written down decision by decision so you can read it, challenge it, and, with permission, build on it.

<table>
<tr><td><b>Replaces</b></td><td>EC2, S3, RDS, Cognito, IAM, Secrets Manager, KMS, Lambda, SQS and SNS, ElastiCache, CloudWatch, X Ray, ECR, CodePipeline, SageMaker</td></tr>
<tr><td><b>Platform base</b></td><td>Windows Server 2025 Datacenter · Hyper V · Failover Clustering · Storage Spaces Direct · Service Fabric · Active Directory</td></tr>
<tr><td><b>Security</b></td><td>Hardware root of trust, WDAC code integrity, IPsec domain isolation, no standing admin rights, object locked backups at two sites</td></tr>
<tr><td><b>Control surface</b></td><td>Web console (.NET 10 and Next.js) · <code>argus</code> PowerShell module and CLI · a GitOps repository that is the only writer of production</td></tr>
<tr><td><b>Targets</b></td><td>RPO 15 minutes · RTO 8 hours for full site loss · 99.9% availability · under 10 minutes from <code>git push</code> to a signed production deploy</td></tr>
<tr><td><b>Linux exceptions</b></td><td>Three hosts, each justified by an ADR: the GPU node, the Wazuh SIEM manager and the Guacamole gateway. OPNsense firewalls are appliances, not servers.</td></tr>
<tr><td><b>Status</b></td><td>Planning · v0.12.0 · October 2026</td></tr>
</table>

## Features

### A complete, decision by decision cloud design
* **34 Architecture Decision Records** covering compute, storage, identity, secrets, networking, observability, backups, CI/CD and machine learning, each with the alternatives rejected and why.
* **Application infrastructure map** tracing every workload to its service account, bucket, port, certificate and backup.
* **Security architecture** with a threat model, controls and the evidence each control produces.
* **Hardware and licensing** bill of materials, including Windows Server and SQL Server costs.
* **Runbooks** for day one, failure drills and recovery.

### A self hosted stack you can run locally
* Docker Compose stack with **OpenBao** secrets, **SeaweedFS** S3 compatible object storage, **PostgreSQL with PostGIS**, **Garnet** cache, **NATS JetStream** queues, **Nomad**, **Prometheus**, **Grafana**, **Loki**, **Alertmanager** and **Grafana Alloy**.
* An **S3 parity harness** that runs the same tests against SeaweedFS and LocalStack to prove where the replacement matches AWS and where it deliberately does not.
* An **Argus PowerShell module** for scripting secrets, storage, queues, logs, metrics and alerts.

### A web console benchmarked against AWS, GCP and Azure
* Fifteen screens, a command palette, sortable and token filtered tables, and **recorded browser RDP and SSH** in a drawer that survives navigation.
* **Just in time elevation** with a countdown, and the GitOps reconciler's plan and blast radius shown before any change is approved.
* **Every action carries state.** Approve, reject, grant, revoke, rotate or promote, and the next screen, the audit trail and the navigation counts all change. Reversible actions offer Undo.
* **Shareable views.** The tab and filter live in the URL, and views can be saved by name.
* **Operator grade tables** with bulk selection, keyboard row navigation, a remembered column picker and CSV export of exactly the rows shown.
* **One inbox** for incidents, alerts, approvals, expired waivers, overdue secrets, failed pipelines and firing alarms.
* **Incidents, silences and alarms**, with a commander, a timeline that folds in the audit, and alarm rules with live preview.
* **Policy that is enforced, not described.** Change freezes, two person approval for Tier 0, and error budgets per application.
* **Auditor ready evidence.** A hash chained audit trail you can verify and watch break, and plans shown as unified diffs.
* **Advisor** with about thirty rules across security, fault tolerance, cost, performance and operations, plus time boxed risk acceptance.
* Data freshness indicators, idle lock resumed by a security key, and automatic light and dark themes.

### Tests that actually test
413 assertions across 31 suites in headless Chromium against the rendered DOM: **axe core WCAG 2.1 A and AA** on every screen and overlay, real keyboard traversal with focus trapping, contrast computed from rendered pixels, six viewport widths, **WCAG 1.4.10 reflow** at 200% and 400% zoom, a density budget for a 1366×768 laptop, layout leak detection, and a security pass proving `innerHTML` appears nowhere. Sandbox checks and stress budgets run alongside.

## Quick start

Running anything below is use of the Work and needs [permission](#license) first. With that in hand, open the console prototype. No build, no server, no network:

```bash
open platform/console/prototype/index.html
```

Run the test suite:

```bash
npm ci
npx playwright install chromium
npm test
```

Run every suite, including sandbox and stress:

```bash
npm run test:all
```

### Before you buy any hardware

Run the [day one lab runbook](docs/runbooks/boot-01-day-one.md): five days on one spare machine that test the three assumptions most likely to be wrong. It costs a Windows evaluation licence and a week. Ordering hardware first risks $85k to $110k against an untested design.

## Architecture

<table>
<tr><th>Layer</th><th>Argus component</th><th>AWS equivalent</th></tr>
<tr><td>Compute</td><td>Hyper V failover cluster, Service Fabric</td><td>EC2, ECS, Lambda</td></tr>
<tr><td>Storage</td><td>Storage Spaces Direct, SeaweedFS</td><td>EBS, S3</td></tr>
<tr><td>Databases</td><td>SQL Server, PostgreSQL with PostGIS</td><td>RDS</td></tr>
<tr><td>Cache and messaging</td><td>Garnet, NATS JetStream</td><td>ElastiCache, SQS, SNS</td></tr>
<tr><td>Identity</td><td>Active Directory, AD FS, tiered administration</td><td>IAM, Cognito</td></tr>
<tr><td>Secrets and PKI</td><td>OpenBao, AD CS</td><td>Secrets Manager, KMS, ACM</td></tr>
<tr><td>Edge and network</td><td>Caddy with Coraza WAF, YARP, OPNsense HA with CrowdSec, IPsec</td><td>ALB, WAF, Security Groups</td></tr>
<tr><td>Observability</td><td>Prometheus, Grafana, Loki, OpenTelemetry, Sysmon, Wazuh</td><td>CloudWatch, X Ray, GuardDuty</td></tr>
<tr><td>Delivery</td><td>GitHub Actions on self hosted runners, Forgejo mirror, first party GitOps reconciler, OpenTofu, DSC v3</td><td>CodePipeline, CloudFormation</td></tr>
<tr><td>Remote access</td><td>Apache Guacamole browser RDP and SSH</td><td>Systems Manager Session Manager</td></tr>
<tr><td>Machine learning</td><td>Dedicated GPU node</td><td>SageMaker</td></tr>
</table>

### Repository layout

<table>
<tr><td><code>docs/</code></td><td>The plan. Read these first.</td></tr>
<tr><td><code>docs/adr/</code></td><td>One file per architecture decision, numbered.</td></tr>
<tr><td><code>docs/runbooks/</code></td><td>Operational procedures, one per failure or task.</td></tr>
<tr><td><code>platform/console/</code></td><td>Argus Console: the web control surface, prototype and server.</td></tr>
<tr><td><code>platform/cli/</code></td><td>The Argus PowerShell module and thin CLI.</td></tr>
<tr><td><code>platform/compose/</code></td><td>The self hosted stack for local development and parity testing.</td></tr>
<tr><td><code>platform/gitops/</code></td><td>Desired state of the platform: apps, VMs, buckets, secret references, policies.</td></tr>
<tr><td><code>platform/policies/</code></td><td>WDAC, GPO baselines, firewall and IPsec rules, Wazuh rules.</td></tr>
<tr><td><code>platform/iac/</code></td><td>OpenTofu with the Hyper V provider, and DSC v3 for hosts and VMs.</td></tr>
<tr><td><code>CHANGELOG.md</code></td><td>Every change to the plan, dated, with the reason.</td></tr>
</table>

## Documentation

1. [Master plan](docs/00-MASTER-PLAN.md): what is being built, the targets, the phases.
2. [Decisions](docs/01-DECISIONS.md): **why** every component was chosen, what it replaces and what was rejected.
3. [Application infrastructure map](docs/02-APPLICATION-INFRASTRUCTURE-MAP.md): every application down to its service account, bucket, port and backup.
4. [Security architecture](docs/03-SECURITY-ARCHITECTURE.md): controls, threat model and evidence.
5. [Network and sites](docs/04-NETWORK-AND-SITES.md): zones, VLANs, addressing and the two sites.
6. [Control plane](docs/05-CONTROL-PLANE.md): the console, the CLI and the GitOps flow.
7. [Phases and runbooks](docs/06-PHASES-AND-RUNBOOKS.md): the schedule with exit gates.
8. [Hardware and licensing](docs/07-HARDWARE-AND-LICENSING.md): bill of materials and licensing.
9. [Open questions](docs/08-OPEN-QUESTIONS.md): decisions still needed.
10. **[Validation status](docs/09-VALIDATION-STATUS.md): what is actually tested and what is not.**
11. [Console design](docs/10-CONSOLE-DESIGN.md): every screen, including browser RDP.
12. [Console UX benchmark](docs/11-CONSOLE-UX-BENCHMARK-AND-BUGS.md): the AWS, GCP and Azure comparison and every bug found.
13. [Console stress and performance](docs/12-CONSOLE-STRESS-AND-PERFORMANCE.md): budgets and results.

## How changes happen

Nothing about this platform changes without a commit here. A new component, a removed one, a changed port or a rotated key policy is an ADR in `docs/adr/`, a line in the changelog, and a change under `platform/`. The git history is the history of why the platform is the way it is.

## Contributing

Challenges and corrections are welcome. The most valuable contribution is proving an assumption wrong. Read the [contributing guide](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md) and the [security policy](SECURITY.md), then open an issue using the *Assumption proved wrong* or *Challenge a decision* template. Anything you submit is assigned to the author under the [licence](LICENSE).

## Related projects

* [QGIS MCP](https://github.com/Adilmunawar/QGIS_MCP): a Model Context Protocol server that connects AI assistants to QGIS.

## Author

Built and maintained by **[Adil Munawar](https://github.com/Adilmunawar)**, ML Research and Development. Portfolio: [adilmunawar.vercel.app](https://adilmunawar.vercel.app).

## License

Copyright © 2026 Adil Munawar. **All rights reserved.**

This repository is **not** open source and carries no open source licence. You may read it on GitHub. Any other use, including running the console or the compose stack, copying the documents, deploying the design, building a derivative, or using any of it to train a model, requires the author's **prior written permission**, granted case by case.

To ask for permission, contact [Adil Munawar on GitHub](https://github.com/Adilmunawar) or email adilmunawarx@gmail.com with who you are, what you want to use, and for what. Silence is not permission. The full terms are in [LICENSE](LICENSE); what is usually granted, and how to ask, is in the [use and permission policy](USE-POLICY.md). The name is reserved under [TRADEMARK.md](TRADEMARK.md), and copies published without permission are handled under [ENFORCEMENT.md](ENFORCEMENT.md).

Versions published before 1 November 2026 were MIT licensed; copies obtained under that licence keep it. Third party components referenced or bundled here stay under their own licences.

<div align="center">

**If this project helped your thinking, please give it a ⭐ and share the link with someone planning a cloud exit.**

</div>
