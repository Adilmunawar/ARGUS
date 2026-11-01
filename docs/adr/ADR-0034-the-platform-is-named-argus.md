# ADR-0034: The platform is named Argus

**Status:** Accepted (8 September 2026)

## Context

The platform began under a working name taken from the business that commissioned it. That is a company name wearing a product's clothes: it ties the platform to one business, and it makes the product indistinguishable from every other internal tool with the same initials. The platform needed a name of its own.

## Options

(a) Keep the working name. (b) A name rooted in local place or language. (c) A name in the infrastructure register: a star, a particle, a fortification.

## Decision

**Argus**, from (c). The identifier prefix is the full word `argus`, never a three-letter abbreviation.

That second sentence is part of the decision, not a note on it. ADR-0023 exists specifically to say this platform does **not** use Flux or Argo, and an `arg-` prefix on buckets, clusters and services would read as Argo to every engineer who joins. Spending three extra characters removes the ambiguity permanently.

## Why

Argus Panoptes is the hundred-eyed giant who never slept: the watchman, some eyes always open while the rest rested. That is a fair description of what this platform is built to be, and it lines up with the one principle the whole design rests on: *evidence, not assurance* (`00-MASTER-PLAN.md` §5). Sysmon on every host, Windows Event Forwarding into Wazuh, WDAC block events, recorded RDP sessions in an object-locked bucket, an audit table that keeps every action forever. The name is the thesis.

It also reads as infrastructure rather than as any one business, and it survives the platform outliving any one application on it.

## Consequences

- **Everything is relabelled.** Domains, buckets, databases, schemas, NATS subjects, clusters, directory groups, certificate templates, the GitOps `apiVersion` and project names all take the `argus` prefix.
- **The visual identity is an open question.** The console mark is a leaf inherited from an earlier design system. The tokens and components stay (`10-CONSOLE-DESIGN.md` §5); the mark itself needs a decision before stage C1 ships.
- **The name is not yet cleared.** There is an older network-monitoring tool called Argus and an Argus Media in commodities pricing; neither is in this market, but neither has been checked properly. Trademark and domain verification is **Q13** in `08-OPEN-QUESTIONS.md` and must be closed before the name appears on anything outside this repository.
- ADRs 0001-0033 were relabelled mechanically. Their substance is untouched: no decision changed, only the product's name. This ADR is the record that the relabelling happened, so `git log` still answers "why is it like this?".

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
