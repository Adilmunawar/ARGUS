# Security policy

Argus is the control plane for a private cloud. A defect here is a defect in
the thing that holds the keys, so this document says exactly what we support,
how to report a problem, and what we will do about it.

## Supported versions

Argus is pre-1.0 and ships from `main`. Only the most recent minor release
carries fixes.

| Version | Supported | Notes |
| --- | --- | --- |
| 0.6.x | Yes | Current release line |
| 0.5.x | No | Superseded by 0.6.0 |
| < 0.5 | No | Pre-naming (`ZD Cloud`); no fixes |

## Reporting a vulnerability

**Do not open a public issue for a security defect.**

Report privately through GitHub's advisory flow:

- <https://github.com/Adilmunawar/Argus/security/advisories/new>

If that is unavailable to you, contact the maintainer directly and say only
that you have a security report; do not include details in the first message.

### What to include

A report we can act on has:

1. The component: console prototype, GitOps schema, reconciler, IaC, CLI.
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
- `platform/cli/Argus/` — argument injection, credential handling.
- Any secret, key, certificate, or live hostname committed to this repository.

### Out of scope

- The production deployment at `*.zaraatdost.pk`. This repository is the
  design and the control plane; testing the live estate is not authorised by
  this policy.
- Findings that require a compromised operator workstation or physical access
  to a domain-joined host.
- Missing hardening headers on the prototype opened from `file://`. The
  prototype is a static design artefact; `frame-ancestors` and HSTS are sent
  by Caddy in a real deployment (ADR-0016).
- Denial of service by volume.
- Absence of a feature that a security scanner expects but no ADR mandates.

## Design commitments

These are properties the console is built to hold. A report that breaks one of
them is a vulnerability, not a feature request.

- **No network egress.** The console fetches nothing — no fonts, no CDN, no
  analytics, no telemetry (ADR-0027). Any outbound request is a defect.
- **No HTML from data.** Screens build DOM through `ui.el()`, which escapes by
  construction. `innerHTML` is not used with data anywhere; `ui.el` throws on
  an `html` attribute. Alert rules, log lines, commit messages, and file names
  all arrive from outside the product.
- **Content Security Policy.** `default-src 'none'` with `script-src 'self'`
  and no inline handlers. The test suite fails the build if an inline handler
  or an external origin appears.
- **Elevation is time-boxed and recorded.** Standing rights do not include
  destructive operations. Elevation requires a second factor, carries a
  reason, expires on a wall clock, and is written to the audit.
- **Destructive actions name their environment.** Anything irreversible
  requires typing the resource name and displays the environment it will run
  against.
- **No credential ever reaches the browser.** Session credentials are
  one-time, issued by OpenBao, and never rendered.

## Verification

Security properties are enforced by the test suite, not by review alone. The
`SEC` suite in `platform/console/prototype/tests/run-tests.js` asserts the CSP
is present, that no external origin is referenced, that no inline event
handler exists, and that no credential-shaped string is rendered. Run it with:

```bash
npm test
```

The suite exits with the number of failures, so CI gates on it
(`.github/workflows/validate.yml`).

## Credit

Reporters who follow this policy are credited in the advisory and the
changelog unless they ask not to be.
