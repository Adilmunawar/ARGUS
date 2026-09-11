#!/usr/bin/env bash
#
# publish.sh: create the GitHub repository, push, release, and protect main.
#
#   cd argus
#   ./publish.sh                    # public  (default)
#   ./publish.sh --private          # start private, flip later
#   ./publish.sh --name my-repo     # different repository name
#
# Authentication: this uses the GitHub CLI's own login. Run `gh auth login`
# once and it stores an OAuth token in your system keychain. Nothing is typed
# into a script, pasted into a URL, or written to .git/config in plain text.
#
# If you must use a PAT instead, export it yourself before running:
#   read -rs GH_TOKEN && export GH_TOKEN     # -s hides it, and it stays out of shell history
# Never pass a token as a command-line argument: arguments are visible to every
# other process on the machine via `ps`.

set -euo pipefail

NAME="argus"
VISIBILITY="--public"
WEBSITE="https://adilmunawar.vercel.app"

DESCRIPTION="Sovereign, Windows-first private cloud replacing AWS on owned hardware. 34 architecture decisions, a full application-infrastructure map, hardware-rooted security, and a tested web console with browser RDP. Includes what has been verified and what has not."

TOPICS="private-cloud,self-hosted,windows-server,hyper-v,service-fabric,active-directory,gitops,infrastructure-as-code,architecture-decision-records,zero-trust,devops,aws-alternative,cloud-migration,disaster-recovery,openbao,seaweedfs,powershell,dotnet,design-system,accessibility"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --private) VISIBILITY="--private"; shift ;;
    --public)  VISIBILITY="--public";  shift ;;
    --name)    NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;32m▸\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
command -v git >/dev/null || die "git is not installed."
command -v gh  >/dev/null || die "GitHub CLI is not installed. https://cli.github.com, then run: gh auth login"
[[ -d .git ]] || die "Run this from inside the argus repository."
gh auth status >/dev/null 2>&1 || die "Not signed in. Run: gh auth login"

[[ -z "$(git status --porcelain)" ]] || die "You have uncommitted changes. Commit or stash them first."

say "Checking for credentials before anything leaves this machine"
if git log -p --all 2>/dev/null | grep -qE 'ghp_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9-]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
  die "A credential-shaped string is in the git history. Do not push. Remove it, rewrite the history, and rotate the credential."
fi
echo "  clean: nothing credential-shaped in $(git rev-list --count HEAD) commits"

if command -v node >/dev/null && [[ -f platform/console/prototype/tests/run-tests.js ]]; then
  say "Running the console test suite"
  node platform/console/prototype/tests/run-tests.js || die "Tests failed. Fix them before publishing."
fi

OWNER="$(gh api user --jq .login)"
say "Publishing as $OWNER/$NAME  (${VISIBILITY#--})"
read -rp "  Continue? [y/N] " ok
[[ "$ok" =~ ^[Yy]$ ]] || { echo "  Cancelled."; exit 0; }

# ── Create ───────────────────────────────────────────────────────────────────
if gh repo view "$OWNER/$NAME" >/dev/null 2>&1; then
  say "Repository already exists, adding it as a remote"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$NAME.git"
else
  say "Creating the repository"
  gh repo create "$NAME" $VISIBILITY --source=. --remote=origin --description "$DESCRIPTION"
fi

say "Setting description, website and topics"
gh repo edit "$OWNER/$NAME" --description "$DESCRIPTION" --homepage "$WEBSITE" \
  --enable-issues --enable-wiki=false --enable-projects=false
gh repo edit "$OWNER/$NAME" --add-topic "$TOPICS"

say "Pushing $(git rev-list --count HEAD) commits and $(git tag | wc -l | tr -d ' ') tags"
git push -u origin main
git push --tags

# ── Release ──────────────────────────────────────────────────────────────────
LATEST="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [[ -n "$LATEST" ]] && ! gh release view "$LATEST" >/dev/null 2>&1; then
  say "Cutting release $LATEST"
  NOTES="$(awk -v tag="${LATEST#v}" '
    $0 ~ "^## \\[" tag "\\]" {p=1; next}
    p && /^## \[/ {exit}
    p {print}' CHANGELOG.md)"
  gh release create "$LATEST" --title "$LATEST" --notes "${NOTES:-See CHANGELOG.md}"
fi

# ── Protect ──────────────────────────────────────────────────────────────────
# Signed commits are deliberately not required here. Turning that on without a
# signing key configured locks the owner out of their own repository. Configure
# signing first, then enable it in Settings -> Branches. ADR-0023 has the
# reconciler verify signatures regardless of what GitHub enforces.
say "Protecting main: pull request required, validate check required"
gh api -X PUT "repos/$OWNER/$NAME/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=GitOps schema and secret scan' \
  -f 'required_status_checks[contexts][]=Console prototype tests' \
  -f 'enforce_admins=false' \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -f 'restrictions=' 2>/dev/null \
  && echo "  protected" \
  || echo "  Skipped: branch protection needs a paid plan on private repos. Set it in Settings → Branches."

# Free for public repositories.
gh api -X PATCH "repos/$OWNER/$NAME" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled' >/dev/null 2>&1 \
  && echo "  secret scanning and push protection enabled" || true

say "Done"
echo "  https://github.com/$OWNER/$NAME"
echo "  Actions: https://github.com/$OWNER/$NAME/actions"
echo
echo "  The validate workflow runs on this push. If it is red, it is almost"
echo "  certainly the Playwright browser install on the runner: check the"
echo "  'console' job before assuming a real failure."
