# Contributing

This repository is the design record for a platform that is being built. The most useful contribution is a challenge to a decision, not a typo fix.

## How a change happens

Every change to the platform is three things together: an **ADR**, a **changelog line**, and a **commit**. Nothing about the platform changes without all three, because `git log` is meant to be the answer to "why is it like this?".

1. **Challenging a decision**: open an issue using the *Challenge a decision* template. Name the ADR, say what it gets wrong, and what you would do instead. If it holds up, the outcome is a new ADR that supersedes the old one. ADRs are never edited once accepted; they are superseded.
2. **A new decision**: add `docs/adr/ADR-00NN-<slug>.md` in the existing shape (Context, Options, Decision, Why, Consequences), add a row to the table in `docs/01-DECISIONS.md`, and add a `### Changed` or `### Added` line to `CHANGELOG.md`.
3. **A platform change**: edit the relevant file under `platform/` in the same pull request as the ADR that justifies it. The GitOps YAML validates against `platform/gitops/schemas/`.
4. **A console change**, run the test suite and include the result:
   ```bash
   node platform/console/prototype/tests/run-tests.js
   ```
   The exit code is the number of failures. A pull request that lowers the pass count needs an explanation in the description.

## Standards

- **Confidence is stated, not implied.** If a claim is not verified, say which of *Grounded*, *Reasoned* or *Assumed* it is: see `docs/09-VALIDATION-STATUS.md`. An assumption presented as a fact is the most expensive kind of error in this repository.
- **Never commit a secret.** Not a token, not a connection string, not a certificate. The GitOps files reference OpenBao paths by name; the schema rejects inline secrets, and that check exists because a previous repository at this company shipped an `sa` password in its history.
- **Write for the person on call at 3 a.m.**, not for the person who already knows. Plain sentences, no jargon that is not defined, honest about what does not work yet.
- **Commit messages explain why.** The subject says what changed; the body says what it cost and what it replaced.
