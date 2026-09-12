#!/usr/bin/env bash

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

command -v git >/dev/null || die "git is not installed."
command -v gh  >/dev/null || die "GitHub CLI is not installed. https://cli.github.com, then run: gh auth login"
[[ -d .git ]] || die "Run this from inside the argus repository."
gh auth status >/dev/null 2>&1 || die "Not signed in. Run: gh auth login"

[[ -z "$(git status --porcelain)" ]] || die "You have uncommitted changes. Commit or stash them first."

say "Checking for credentials before anything leaves this machine"
history_hits="$(git log -p --all 2>/dev/null \
  | grep -cE 'ghp_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9-]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----' || true)"
if [ "${history_hits:-0}" -gt 0 ]; then
  die "$history_hits credential-shaped string(s) are in the git history. Do not push. Remove them, rewrite the history, and rotate every credential."
fi

if command -v python3 >/dev/null && [[ -f .github/scripts/scan-secrets.py ]]; then
  python3 .github/scripts/scan-secrets.py >/dev/null \
    || die "The working tree scanner found a credential. Run .github/scripts/scan-secrets.py to see it."
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

BRANCH="$(git symbolic-ref --short HEAD)"
say "Pushing $(git rev-list --count HEAD) commits and $(git tag | wc -l | tr -d ' ') tags"
git push -u origin "$BRANCH"
git push --tags

LATEST="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [[ -n "$LATEST" ]] && ! gh release view "$LATEST" >/dev/null 2>&1; then
  say "Cutting release $LATEST"
  NOTES="$(awk -v tag="${LATEST#v}" '
    $0 ~ "^## \\[" tag "\\]" {p=1; next}
    p && /^## \[/ {exit}
    p {print}' CHANGELOG.md)"
  gh release create "$LATEST" --title "$LATEST" --notes "${NOTES:-See CHANGELOG.md}"
fi

BRANCH="$(git symbolic-ref --short HEAD)"

say "Protecting $BRANCH: pull request required, validate checks required"
protection_payload() {
  cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Repository invariants", "Console prototype tests", "Console server tests"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null
}
JSON
}

if protect_err="$(protection_payload | gh api -X PUT \
    "repos/$OWNER/$NAME/branches/$BRANCH/protection" \
    -H "Accept: application/vnd.github+json" --input - 2>&1 >/dev/null)"; then
  echo "  protected"
else
  echo "  Branch protection was NOT applied:"
  printf '    %s\n' "$protect_err" | head -3
fi

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
