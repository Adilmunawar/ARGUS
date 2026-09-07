# Publishing this to GitHub

Everything is committed and tagged. Four commands and it's live.

## Before anything: check your credentials

Publish with the GitHub CLI's own login (`gh auth login`), which stores an OAuth token in the system keychain. Nothing then needs to be typed into a script, pasted into a URL, or written to `.git/config` in plain text.

If a personal access token has ever been pasted somewhere it should not have been, revoke it before pushing: **github.com → Settings → Developer settings → Personal access tokens → Delete**. Create a fresh one scoped to what you actually need, with a short expiry. GitHub's push protection scans for its own token format, so a leaked `ghp_` string is often auto-revoked, but that is a backstop and not a plan.

## Repository metadata

**Name**

```
argus
```

Short, and it matches the product name used throughout the docs. Alternatives if you want the scope obvious from the name alone: `argus-platform`, or `sovereign-cloud-platform` if you'd rather lead with the idea than the company.

**Description** (350 char limit; this is what shows in search results)

```
Sovereign, Windows-first private cloud replacing AWS on owned hardware. 34 architecture decisions, a full application-infrastructure map, hardware-rooted security, and a tested web console with browser RDP. Includes what has been verified and what has not.
```

**Website**

```
https://adilmunawar.vercel.app
```

**Topics** (GitHub allows 20; these are all real, indexed topics)

```
private-cloud          self-hosted            windows-server         hyper-v
service-fabric         active-directory       gitops                 infrastructure-as-code
architecture-decision-records                 zero-trust             devops
aws-alternative        cloud-migration        disaster-recovery      openbao
seaweedfs              powershell             dotnet                 design-system
accessibility
```

## Publish

```bash
cd argus

# 1. Create the repository (GitHub CLI: it prompts for auth, so no token in your shell history)
gh auth login
gh repo create argus \
  --public \
  --source=. \
  --remote=origin \
  --description "Sovereign, Windows-first private cloud replacing AWS on owned hardware. 34 architecture decisions, a full application-infrastructure map, hardware-rooted security, and a tested web console with browser RDP. Includes what has been verified and what has not."

# 2. Topics
gh repo edit --add-topic private-cloud,self-hosted,windows-server,hyper-v,service-fabric,active-directory,gitops,infrastructure-as-code,architecture-decision-records,zero-trust,devops,aws-alternative,cloud-migration,disaster-recovery,openbao,seaweedfs,powershell,dotnet,design-system,accessibility

# 3. Push the history and the tags
git push -u origin main
git push --tags

# 4. Cut the release
gh release create v0.5.0 \
  --title "v0.5.0: the platform is named Argus" \
  --notes-file <(sed -n '/## \[0.5.0\]/,/## \[0.4.0\]/p' CHANGELOG.md | head -n -1)
```

Without `gh`: create the repository in the web UI (public, no README, no licence, no `.gitignore`, this repo has all three), then:

```bash
git remote add origin https://github.com/<you>/argus.git
git push -u origin main && git push --tags
```

Use a credential manager or SSH rather than pasting a token into the URL: a token in a remote URL ends up in `.git/config` in plain text.

## After the first push

**Protect `main`.** Settings → Branches → Add rule for `main`: require the `validate` check to pass, and block force pushes and deletions.

Signed commits are the rule this repository specifies for the platform (ADR-0023 has the reconciler refuse unsigned commits), so it should eventually hold itself to that rule. Configure signing locally first: `git config user.signingkey`, `git config commit.gpgsign true`, and add the public key under Settings → SSH and GPG keys. Requiring signatures before that is set up locks you out of your own repository.

**Turn on secret scanning and push protection.** Settings → Code security. Free for public repositories, and it catches a credential before it ever reaches a commit.

**Check the CI badge goes green.** The `validate` workflow runs the GitOps schema check, a credential scan, and the 65-assertion console suite in headless Chromium. If it's red on the first run, it's almost certainly the Playwright browser install step on the runner.

## What a visitor sees first

The README opens with the badges and an at-a-glance table, then sends people to `docs/09-VALIDATION-STATUS.md` before anything else. That's deliberate. A repository this confident-looking that doesn't say what's untested is the kind that gets someone into trouble, and the honesty is more likely to earn respect than the architecture is.
