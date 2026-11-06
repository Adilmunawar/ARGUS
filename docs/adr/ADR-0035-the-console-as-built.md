# ADR-0035: The console as built: an ES5 prototype served by a small Node API

**Status:** Accepted · **Date:** 2026-11-05 · **Supersedes:** [ADR-0022](ADR-0022-the-console-is-net-10-next-js-on-service-fabric.md)

## Context

ADR-0022 chose a .NET 10 minimal API and a Next.js 16 front end, deployed as a Service Fabric application behind AD FS. None of that was built. What was built, between September and November 2026, is:

- `platform/console/prototype/`: fifteen screens written as ES5 classic scripts with no build step, no framework and no dependencies at run time. It opens from `file://` with a bundled sample dataset, and the same files run in live mode when an API serves them.
- `platform/console/server/`: a Node API (Node 22 or later, CommonJS) whose only runtime dependencies are the AWS SDK clients, `pg` and `yaml`. It serves the prototype as static files, signs operators in with server-side sessions and scrypt password hashes, checks each route against the operator's role, and exposes read-only `GET` routes over the compose stack: SeaweedFS, PostgreSQL, Garnet, NATS, OpenBao, Prometheus, Alertmanager, Loki, the container socket proxy and the GitOps tree.
- `platform/console/src/`: a `Program.cs` and two READMEs, the placeholders ADR-0022 left. They are not built or tested.

The design documents still described the .NET and Next.js console as if it were the plan of record, and the README called the console ".NET 10 and Next.js". That was not true of the tree.

## Options

(a) Build ADR-0022 as written and treat the prototype as a throwaway mock-up. (b) Keep ADR-0022 as the target and describe the prototype as an interim. (c) Record the console that exists as the decision, and keep ADR-0022's integration points (AD FS, AD groups as roles, Service Fabric hosting) as the target for when the platform itself exists.

## Decision

(c). The console is an ES5 classic-script front end served by a dependency-light Node API. Specifically:

1. **Front end.** ES5, classic scripts, no modules, no `innerHTML`, a strict Content Security Policy. Screens build DOM through `ui.el()`. It must keep opening from `file://` with sample data, because the console has to be usable from a memory stick during a site failure.
2. **API.** One Node process, read-only by default (`ARGUS_ALLOW_WRITES` is off and there are no write routes yet), session sign-in against an operator file with four roles (viewer, operator, security, admin), a proxy mode for a trusted reverse proxy, and `ARGUS_AUTH=off` allowed only on loopback.
3. **Writes** (approve, grant, rotate, freeze, deploy) stay in sample mode until the reconciler exists. When they arrive they go through the API as pull requests against the GitOps repository, as ADR-0021 requires, not as direct calls to the systems.
4. **Integration targets kept from ADR-0022.** AD FS in front of the API through the proxy mode, AD groups mapped to console roles, and hosting on the platform's scheduler once there is one.

## Why

- The prototype already carries the value: fifteen screens, an accessibility and layout suite of over four hundred assertions, a live suite that drives it against the API over http and against the composed stack, a sandbox suite across nine environments and a stress suite with budgets. Rewriting it in Next.js would spend months reaching where it already is.
- ES5 with no build step has no supply chain at run time. The browser loads the files in the repository and nothing else, which suits the most privileged interface on the platform.
- The Node API is small enough to read in an afternoon. Its job is to read other systems and say plainly when one is missing; it holds no state that matters beyond sessions and a bounded audit ring.
- Nothing in the platform runs .NET yet. Service Fabric, AD FS and the reconciler are all design only, so a .NET console would have had nowhere to be deployed.

## Consequences

- The console's audit trail is an in-memory ring on the API. The hash chain the Audit screen computes proves the rows were not altered in transit to the page; it does not prove the API's memory was not altered. Durable audit waits for `argus_console_events` (docs/05).
- Approve, grant, rotate, freeze and two-person approval work only against the sample dataset. The README's "What runs today" table says so.
- Browser RDP is a simulated drawer in the prototype. Guacamole runs in the compose stack's `connect` profile, but the console does not broker sessions to it yet.
- `platform/console/src/` stays as placeholders for the target design and is not referenced by any build.
- The CLI (`platform/cli/Argus`) is a client of this API and authenticates the way it does.

## What would make us revisit this

- The reconciler is built and the console needs write paths with a typed contract shared with it. A typed language on the server becomes worth its cost then, not before.
- The front end outgrows hand-built DOM: a screen that needs client-side state the current helpers cannot carry without becoming unreadable.
- A requirement to run inside Service Fabric with its health model, which the Node process would have to be adapted to.
- An audit or security review that rejects a dependency-free ES5 front end for a reason not foreseen here.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
