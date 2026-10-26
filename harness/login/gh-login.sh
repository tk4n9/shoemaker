#!/usr/bin/env bash
# gh-login.sh — log the GitHub CLI in for this project's Shoemaker agents.
#
# Run it in YOUR OWN terminal, never inside an agent session: a pasted token would
# land in that session's transcript. --insecure-storage keeps the credential in
# gh's config file (~/.config/gh/hosts.yml, mode 0600) instead of a desktop
# keyring, which the systemd service cannot unlock.
set -euo pipefail

# `shoemaker login` runs this with SHOEMAKER_STATE set to the project's state directory.
[ -f "${SHOEMAKER_STATE:-}/shoemaker.conf" ] || { echo "${0##*/}: run it as: shoemaker login" >&2; exit 1; }
# shellcheck disable=SC1091
. "$SHOEMAKER_STATE/shoemaker.conf"

[ -t 0 ] || { echo "gh-login: run this in an interactive terminal." >&2; exit 1; }
command -v gh >/dev/null || { echo "gh-login: install the GitHub CLI first (https://cli.github.com)." >&2; exit 1; }
echo "gh: $(command -v gh) ($(gh --version | head -1))"
cat <<'EOF'

How do you want to log in?
  1) Browser (recommended): a one-time code in your browser; no token to manage, does not expire.
  2) Token: a personal access token you create yourself.
     Classic: scopes repo, read:org.
     Fine-grained, for this repository only: Contents read/write,
     Pull requests read/write, Checks read, Commit statuses read, Metadata read.
EOF
read -rp "Choice [1/2]: " choice
if [ "${choice:-1}" = 2 ]; then
  printf 'GitHub token (input hidden): '; IFS= read -rs T; echo
  [ -n "$T" ] || { echo "gh-login: no token given; nothing changed." >&2; exit 1; }
  printf '%s' "$T" | gh auth login --hostname github.com --git-protocol ssh --insecure-storage --with-token
  unset T
else
  gh auth login --hostname github.com --git-protocol ssh --insecure-storage --web
fi

echo; echo "Checking from $REPO ..."
cd "$REPO"
ok=1
gh api user --jq '"  ok    user     @" + .login' || { echo "  FAIL  user"; ok=0; }
gh repo view --json nameWithOwner,viewerPermission \
  --jq '"  ok    repo     \(.nameWithOwner): your permission \(.viewerPermission)"' \
  || { echo "  FAIL  repo     (no access to this repository with that login)"; ok=0; }
[ "$ok" = 1 ] && echo "Done. Runs can open and merge PRs (see shoemaker.conf GATE)." || exit 1
