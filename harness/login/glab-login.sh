#!/usr/bin/env bash
# glab-login.sh — log the GitLab CLI in for this project's Shoemaker agents.
#
# Run it in YOUR OWN terminal, never inside an agent session: the token is read
# without echoing it and goes only to glab. glab picks the host from the git
# remote, so the entry is the remote's host. A self-hosted GitLab may serve its API
# elsewhere (shoemaker.conf GITLAB_API_HOST). --insecure-storage keeps the token in
# ~/.config/glab-cli/config.yml (mode 0600), not a keyring the systemd
# service cannot unlock.
set -euo pipefail

# `shoemaker login` runs this with SHOEMAKER_STATE set to the project's state directory.
[ -f "${SHOEMAKER_STATE:-}/shoemaker.conf" ] || { echo "${0##*/}: run it as: shoemaker login" >&2; exit 1; }
# shellcheck disable=SC1091
. "$SHOEMAKER_STATE/shoemaker.conf"

url="$(git -C "$REPO" config --get "remote.$REMOTE.url")"   # literal: get-url applies insteadOf rewrites
host="$(sed -E 's#^[a-z+]+://##; s#^[^@/]*@##; s#[:/].*$##' <<<"$url")"
api="${GITLAB_API_HOST:-$host}"

[ -t 0 ] || { echo "glab-login: run this in an interactive terminal." >&2; exit 1; }
command -v glab >/dev/null || { echo "glab-login: install the GitLab CLI (glab) first." >&2; exit 1; }
echo "glab: $(command -v glab) ($(glab --version 2>/dev/null | head -1))"
glabs="$(type -ap glab | xargs -r -n1 readlink -f | awk '!seen[$0]++' | while read -r g; do echo "$g=$("$g" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; done)"
if [ "$(cut -d= -f2 <<<"$glabs" | sort -u | wc -l)" -gt 1 ]; then
  echo "NOTE: glab versions differ on PATH ($(tr '\n' ' ' <<<"$glabs")): the first wins, and an old one can fail to parse a newer config."
fi
cat <<EOF

Remote host: $host    API: https://$api/api/v4/

1. Create a token at https://$api/-/user_settings/personal_access_tokens
   Choose "Generate token" -> "Legacy token" (a fine-grained token lacks
   permissions glab needs, such as reading your user).
   Scopes: api, write_repository. Expiry: the latest date allowed.
2. Paste it below. Input is hidden.

EOF
printf 'GitLab token: '; IFS= read -rs T; echo
[ -n "$T" ] || { echo "glab-login: no token given; nothing changed." >&2; exit 1; }
printf '%s' "$T" | glab auth login --hostname "$host" --api-host "$api" \
  --api-protocol https --git-protocol ssh --insecure-storage --stdin
unset T
# An interactive login can write a subfolder key that overrides api_host.
glab config set --host "$host" subfolder "" >/dev/null 2>&1 || true

echo; echo "Checking from $REPO ..."
cd "$REPO"
check() {  # check <label> <endpoint> <jq>: one line each; never echoes the token
  local out
  if out="$(glab api "$2" 2>&1)" && printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    printf '  ok    %-8s %s\n' "$1" "$(printf '%s' "$out" | jq -r "$3")"
  else
    printf '  FAIL  %-8s %s\n' "$1" "$(printf '%s' "$out" | grep -oE '[0-9]{3} \{error: [^}]*\}(, \{error_description: [^}]*\})?' | head -1)"
    return 1
  fi
}
ok=1
check user user '"@\(.username)"' || ok=0
check token personal_access_tokens/self '"\(.name): scopes \(.scopes | join(", ")), expires \(.expires_at // "never")"' || ok=0
check project "projects/:id" '"\(.path_with_namespace): pipelines must succeed: \(.only_allow_merge_if_pipeline_succeeds)"' || ok=0
check mrs "projects/:id/merge_requests?per_page=1" '"merge requests readable"' || ok=0
echo
if [ "$ok" = 1 ]; then
  echo "Done. Runs can open and merge MRs (see shoemaker.conf GATE)."
else
  cat <<'EOF'
Some checks failed:
  401 invalid_token                means the token is expired, revoked or mistyped.
  403 insufficient_granular_scope  means a fine-grained token: use "Legacy token" with api, write_repository.
  403 insufficient_scope           means the token lacks the api scope.
Run this helper again with a new token.
EOF
  exit 1
fi
