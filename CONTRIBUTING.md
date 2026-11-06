# Contributing

This repository is the design record for a platform, and the first working pieces of it. **Issues are welcome. Pull requests are not accepted**: every commit is the author's, the licence assigns contributions to the author, and the ownership check in CI rejects commits by anyone else. A pull request opened from another account is closed automatically.

The most useful issue is a challenge to a decision or proof that an assumption is wrong, not a typo report.

## Licensing

Argus is not open source. Reading and discussing it on GitHub is fine; anything else, including cloning it to run, needs the author's written permission under the [licence](LICENSE); the [use and permission policy](USE-POLICY.md) says how to ask. By submitting issue text, or anything else, you assign all rights in it to the author, as the licence states. If you cannot agree to that, describe the problem in your own words without sending text or code to copy.

## Opening an issue

1. **Challenging a decision**: use the *Challenge a decision* template. Name the ADR, say what it gets wrong, what you would do instead, and what evidence would settle it. If it holds up, the author writes a new ADR that supersedes the old one.
2. **An assumption turned out wrong**: use the *An assumption turned out wrong* template for anything in the register in `docs/09-VALIDATION-STATUS.md`. Say how you tested it: environment, versions, exact steps.
3. **Anything else**: a blank issue. For a security problem, do not open an issue; follow `SECURITY.md`.

The templates apply the labels `decision` and `assumption`.

## How the author makes a change

Every change to the platform is three things together: an **ADR**, a **changelog line**, and a **commit**, because `git log` is meant to be the answer to "why is it like this?". A new decision is `docs/adr/ADR-00NN-<slug>.md` in the shape Status, Context, Options, Decision, Why, Consequences, a row in `docs/01-DECISIONS.md`, and a changelog line. A platform change edits `platform/` in the same commit as the ADR that justifies it. A console change runs the four browser suites and the server tests; CI runs them again.

## Standards

- **Confidence is stated, not implied.** If a claim is not verified, say which of *Grounded*, *Reasoned* or *Assumed* it is: see `docs/09-VALIDATION-STATUS.md`. An assumption presented as a fact is the most expensive kind of error in this repository.
- **Never commit a secret.** Not a token, not a connection string, not a certificate. The GitOps files reference OpenBao paths by name; the schema rejects inline secrets, because a database administrator password committed to an application repository's history is one of the commonest leaks there is.
- **Write for the person on call at 3 a.m.**, not for the person who already knows. Plain sentences, no jargon that is not defined, honest about what does not work yet.
- **Commit messages explain why.** The subject says what changed; the body says what it cost and what it replaced.
