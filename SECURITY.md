# Security policy

Argus is the design, and the first working pieces, of the control plane for a
private cloud. A defect here is a defect in the thing meant to hold the keys, so
this document says exactly what is supported, how to report a problem, and what
happens next.

## Supported versions

Argus is pre-1.0 and ships from `main`. Only the most recent minor release
carries fixes.

| Version | Supported | Notes |
| --- | --- | --- |
| `main` | Yes | Unreleased work after 0.12.0 |
| 0.12.x | Yes | Current release line |
| < 0.12 | No | Superseded; move to 0.12.x or `main` |

## Reporting a vulnerability

**Do not open a public issue for a security defect.**

Report privately by email to **adilmunawarx@gmail.com** with the subject
*Argus security report*. If you would rather not send details by plain email,
say so in a first message with no details, and a private channel will be agreed.

GitHub's private vulnerability reporting is not enabled on this repository at
the time of writing. If a *Report a vulnerability* button appears on the
Security tab, it may be used instead.

### What to include

A report we can act on has:

1. The component: console prototype, console API, compose stack, GitOps
   schema, IaC, CLI.
2. The version or commit SHA.
3. What an attacker gains — read of another tenant's data, privilege
   escalation across tiers, bypass of the elevation ladder, code execution.
4. Steps to reproduce, ideally a URL fragment, a manifest, or a payload.
5. Whether the finding is theoretical or you have observed it.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | 3 working days |
| Initial assessment with a severity | 10 working days |
| Fix or documented mitigation for critical findings | 30 days |
| Public advisory | After the fix ships, or 90 days, whichever comes first |

We will tell you which way we are going and why. If we decide a report is not
a vulnerability, you get the reasoning, not silence.

### Safe harbour

We will not pursue or support action against research that respects this
policy: no access to data that is not yours, no degradation of a running
service, no social engineering of staff, and no disclosure before the window
above has run.

## Scope

### In scope

- The console prototype in `platform/console/prototype/` — cross-site
  scripting, DOM injection, CSP bypass, clickjacking, focus and elevation
  ladder bypass, anything that lets a Tier 2 identity perform a Tier 0 action.
- The GitOps manifest schema in `platform/gitops/schemas/` — a manifest that
  validates but grants more than it declares.
- `platform/iac/` and `platform/policies/` — a template that provisions
  something weaker than the ADR that mandates it.
- `platform/console/server/` — authentication and sessions, the origin check,
  the role checks (viewer, operator, security, admin), the read-only gate, path
  traversal in the runbook and GitOps readers, and anything that returns a
  secret value or a password record.
- `platform/compose/` — a default that exposes a service beyond loopback, a
  secret written somewhere readable by other users, a credential in a
  committed file.
- `platform/cli/Argus/` — argument injection, credential handling.
- Any secret, key, certificate, or live hostname committed to this repository.

### Out of scope

- Any running deployment of Argus. There is no public one; `*.example.com`
  names in the documents are samples. Testing someone else's installation is
  not authorised by this policy.
- Findings that require a compromised operator workstation or physical access
  to a domain-joined host.
- Missing hardening headers on the prototype opened from `file://`. The
  prototype is a static design artefact; `frame-ancestors` and HSTS are sent
  by Caddy in a real deployment (ADR-0016).
- Denial of service by volume.
- Absence of a feature that a security scanner expects but no ADR mandates.

## Design commitments

These are properties the console is built to hold. A report that breaks one of
them is a vulnerability, not a feature request. Each says where it holds
today: **built** (enforced in the code and tested), **sample mode** (enforced by
the interface on the bundled dataset only), or **design only** (specified, not
built).

- **No network egress** (built). The console fetches nothing — no fonts, no CDN, no
  analytics, no telemetry (ADR-0027). Any outbound request is a defect.
- **No HTML from data** (built). Screens build DOM through `ui.el()`, which escapes by
  construction. `innerHTML` is not used with data anywhere; `ui.el` throws on
  an `html` attribute. Alert rules, log lines, commit messages, and file names
  all arrive from outside the product.
- **Content Security Policy** (built). `default-src 'none'` with `script-src 'self'`
  and no inline handlers. The test suite fails the build if an inline handler
  or an external origin appears.
- **Elevation is time-boxed and recorded** (sample mode). Standing rights do
  not include destructive operations. Elevation requires a second factor,
  carries a reason, expires on a wall clock, and is written to the audit. The
  API has no elevation; each operator's role is fixed in the operator file.
- **Destructive actions name their environment** (sample mode; the API has
  no destructive action). Anything irreversible
  requires typing the resource name and displays the environment it will run
  against.
- **No credential ever reaches the browser** (built for the API; design only
  for remote sessions). The API never returns a password record or a secret
  value. One-time remote-session credentials issued by OpenBao are design only,
  because the console does not broker sessions yet.

## Verification

Security properties are enforced by the test suite, not by review alone. The
`SEC` suite in `platform/console/prototype/tests/run-tests.js` asserts the CSP
is present, that no external origin is referenced, that no inline event
handler exists, and that no credential-shaped string is rendered. Run it with:

```bash
npm test
```

The console API's authentication, roles and gate are covered by `npm test` in
`platform/console/server`. Both exit non-zero on failure, so CI gates on them
(`.github/workflows/validate.yml`).

## Credit

Reporters who follow this policy are credited in the advisory and the
changelog unless they ask not to be.
