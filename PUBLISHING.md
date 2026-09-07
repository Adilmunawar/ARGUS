# Publishing this to GitHub

Everything is committed and tagged. Four commands and it's live.

## Before anything: revoke the token

The token pasted into our conversation is compromised. Revoke it now:

**github.com → Settings → Developer settings → Personal access tokens → Fine-grained (or Tokens classic) → Delete**

Then create a fresh one, scoped to what you actually need, with a short expiry. Don't paste it anywhere except your own terminal or credential manager. GitHub's push protection scans for its own token format, so a leaked `ghp_` string is often auto-revoked anyway — but don't rely on that.

## Repository metadata

**Name**

```
argus
```

Short, and it matches the product name used throughout the docs. Alternatives if you want the scope obvious from the name alone: `argus-platform`, or `sovereign-cloud-platform` if you'd rather lead with the idea than the company.

**Description** (350 char limit; this is what shows in search results)

```
Sovereign, Windows-first private cloud replacing AWS on owned hardware. 34 architecture decisions, a full application–infrastructure map, hardware-rooted security, and a tested web console with browser RDP. Includes what has been verified and what has not.
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

# 1. Create the repository (GitHub CLI — it prompts for auth, so no token in your shell history)
gh auth login
gh repo create argus \
  --public \
  --source=. \
  --remote=origin \
  --description "Sovereign, Windows-first private cloud replacing AWS on owned hardware. 34 architecture decisions, a full application–infrastructure map, hardware-rooted security, and a tested web console with browser RDP. Includes what has been verified and what has not."

# 2. Topics
gh repo edit --add-topic private-cloud,self-hosted,windows-server,hyper-v,service-fabric,active-directory,gitops,infrastructure-as-code,architecture-decision-records,zero-trust,devops,aws-alternative,cloud-migration,disaster-recovery,openbao,seaweedfs,powershell,dotnet,design-system,accessibility

# 3. Push the history and the tags
git push -u origin main
git push --tags

# 4. Cut the release
gh release create v0.5.0 \
  --title "v0.5.0 — the platform is named Argus" \
  --notes-file <(sed -n '/## \[0.5.0\]/,/## \[0.4.0\]/p' CHANGELOG.md | head -n -1)
```

Without `gh`: create the repository in the web UI (public, no README, no licence, no `.gitignore` — this repo has all three), then:

```bash
git remote add origin https://github.com/<you>/argus.git
git push -u origin main && git push --tags
```

Use a credential manager or SSH rather than pasting a token into the URL — a token in a remote URL ends up in `.git/config` in plain text.

## After the first push

**Protect `main`.** Settings → Branches → Add rule for `main`: require a pull request, require the `validate` check to pass, and require signed commits. That last one matters because `ADR-0023` has the reconciler refusing unsigned commits — the repository should hold itself to the rule it specifies for the platform.

**Turn on secret scanning and push protection.** Settings → Code security. Free for public repositories, and it would have caught the token.

**Check the CI badge goes green.** The `validate` workflow runs the GitOps schema check, a credential scan, and the 65-assertion console suite in headless Chromium. If it's red on the first run, it's almost certainly the Playwright browser install step on the runner.

## What a visitor sees first

The README opens with the badges and an at-a-glance table, then sends people to `docs/09-VALIDATION-STATUS.md` before anything else. That's deliberate. A repository this confident-looking that doesn't say what's untested is the kind that gets someone into trouble, and the honesty is more likely to earn respect than the architecture is.
