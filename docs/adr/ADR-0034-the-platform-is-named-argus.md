# ADR-0034 — The platform is named Argus

**Status:** Accepted (8 September 2026)

## Context

The platform was called ZD Cloud, after Zaraat Dost, the company that owns it. That is a company name wearing a product's clothes, and it carries two costs. It ties the platform's identity to the agriculture business, which is not what the platform is; and it makes the product indistinguishable from every other internal tool with the same initials. The owner ruled on 8 September 2026 that the platform carries its own name.

## Options

(a) Keep ZD Cloud. (b) A name rooted in local place or language — `Doab`, `Qila`, `Bunyad`. (c) A name in the infrastructure register — a star, a particle, a fortification.

## Decision

**Argus**, from (c). The identifier prefix is the full word `argus`, never a three-letter abbreviation.

That second sentence is part of the decision, not a note on it. ADR-0023 exists specifically to say this platform does **not** use Flux or Argo, and an `arg-` prefix on buckets, clusters and services would read as Argo to every engineer who joins. Spending three extra characters removes the ambiguity permanently.

## Why

Argus Panoptes is the hundred-eyed giant who never slept — the watchman, some eyes always open while the rest rested. That is a fair description of what this platform is built to be, and it lines up with the one principle the whole design rests on: *evidence, not assurance* (`00-MASTER-PLAN.md` §5). Sysmon on every host, Windows Event Forwarding into Wazuh, WDAC block events, recorded RDP sessions in an object-locked bucket, an audit table that keeps every action forever. The name is the thesis.

It also reads as infrastructure rather than agriculture, which is the point of separating it from the company brand, and it survives the platform outliving any one application on it.

## Consequences

- **Everything is relabelled.** AD forest `zd.local` → `argus.local`. Buckets `zd-*` → `argus-*`. Databases `ZdConsole` → `ArgusConsole`; PostgreSQL schemas `zd_geo`, `zd_ml`, `zd_console_events` → `argus_*`. NATS subjects `zd.*` → `argus.*`. Clusters `zd-hvc-a/b`, `zd-sf-a`, AG `zd-ag1` → `argus-*`. AD groups `ZD-Console-*`, `ZD-Tier0-Admins` → `Argus-*`. AD CS templates `ZD-Issuing-CA`, `ZD-CodeSigning` → `Argus-*`. GitOps `apiVersion: zdcloud/v1` → `argus/v1`. .NET projects `ZdCloud.*` → `Argus.*`. DSC resources `ZdCloud/*` → `Argus/*`. On-disk root `C:\ZdCloud\` → `C:\Argus\`. The PowerShell module `ZDCloud` → `Argus`, its cmdlets `*-Zd*` → `*-Argus*`, and the thin CLI `zdc` → `argus`. Repositories `zd-cloud` → `argus`, `zd-cloud-gitops` → `argus-gitops`.
- **The company is unchanged.** Zaraat Dost remains the company, `zaraatdost.pk` remains the domain, and `console.zaraatdost.pk` / `api.zaraatdost.pk` are unchanged. The console shell shows the product name over the company name, which is the correct relationship.
- **`docs/adr/superseded/` is left exactly as it was.** It is a historical record of a rejected plan; rewriting names inside it would falsify what was actually proposed on 7 September.
- **Four external names are retained deliberately**: `zd-daily-db-backups` (an existing AWS bucket, not ours to rename), `zdost.aoserv.com` (the current production host), `adilmunawar/ZD-claude-plugin` and its `zd-deploy` / `zd-ops` / `zd-security` plugins (a separate repository — renaming them is its own change).
- **The visual identity is now an open question.** The console mark is a leaf, inherited from the Mills design system. A leaf was right for ZD Cloud; it is not obviously right for Argus. The tokens and components stay (`10-CONSOLE-DESIGN.md` §5); the mark itself needs a decision before stage C1 ships.
- **The name is not yet cleared.** There is an older network-monitoring tool called Argus and an Argus Media in commodities pricing; neither is in this market, but neither has been checked properly. Trademark and `.pk` domain verification is **Q13** in `08-OPEN-QUESTIONS.md` and must be closed before the name appears on anything outside this repository.
- ADRs 0001–0033 were relabelled mechanically. Their substance is untouched — no decision changed, only the product's name. This ADR is the record that the relabelling happened, so `git log` still answers "why is it like this?".

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
