#!/usr/bin/env bash
# detect.sh — read-only facts about a project, for setting Shoemaker up on it.
# Changes nothing.
#
#   shoemaker detect [PATH] PATH: the repository, or an umbrella folder that holds
#                           it under repo/<name> (default: the current directory)
#
# Prints KEY=VALUE lines (values shell-quoted), then NOTE: lines worth raising
# with the user.

set -uo pipefail
p="${1:-.}"; p="$(cd "$p" 2>/dev/null && pwd -P)" || { echo "detect: no such directory: ${1:-.}" >&2; exit 2; }

kv() { printf '%s=%q\n' "$1" "${2:-}"; }
notes=()
note() { notes+=("$*"); }

# --- the repository and an umbrella around it ------------------------------------------
repo="$(git -C "$p" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo" ]; then
  mapfile -t cands < <(find "$p" -mindepth 2 -maxdepth 3 -name .git -prune 2>/dev/null | sed 's#/\.git$##' | sort)
  if [ "${#cands[@]}" -eq 1 ]; then repo="${cands[0]}"
  elif [ "${#cands[@]}" -gt 1 ]; then kv REPO_CANDIDATES "${cands[*]}"; echo "NOTE: several repositories under $p; run shoemaker detect on the one to set up."; exit 0
  else echo "NOTE: no git repository at or under $p."; exit 1; fi
fi
kv REPO "$repo"
kv PROJECT "$(basename "$repo" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/-*$//')"

umbrella=""
parent="$(dirname "$repo")"
if [ "$(basename "$parent")" = repo ]; then
  u="$(dirname "$parent")"
  if ! git -C "$u" rev-parse --git-dir >/dev/null 2>&1 && { [ -f "$u/AGENTS.md" ] || [ -f "$u/CLAUDE.md" ]; }; then umbrella="$u"; fi
fi
kv UMBRELLA "$umbrella"
[ -n "$umbrella" ] && [ -f "$umbrella/STATUSLOG.md" ] && kv UMBRELLA_STATUSLOG "$umbrella/STATUSLOG.md"
if [ -n "$umbrella" ]; then kv SUGGESTED_STATE_DIR "$umbrella/shoemaker"; else kv SUGGESTED_STATE_DIR "$repo/.shoemaker"; fi
for d in "$umbrella/shoemaker" "$repo/.shoemaker"; do
  [ -n "$d" ] && [ -f "$d/shoemaker.conf" ] && { kv EXISTING_STATE "$d"; note "Shoemaker is already set up here ($d): adjust it rather than starting over."; }
done
# An older harness (nightly-agent v1 skill, or a hand-made one) keeps running until it is retired.
for d in "$umbrella/nightly" "$repo/.nightly"; do
  [ -n "$d" ] && [ -f "$d/run.sh" ] && { kv OLD_HARNESS "$d"; note "an older nightly harness is at $d$( [ -f "$d/nightly.conf" ] && echo " (nightly-agent v1)"): ask before replacing it, and disable its timer once Shoemaker takes over."; }
done

# --- remote, host, default branch ----------------------------------------------------------
remote="$(git -C "$repo" remote | grep -x origin || git -C "$repo" remote | head -1)"
url=""; host=none; sshhost=""
if [ -n "$remote" ]; then
  # The literal URL: `git remote get-url` applies insteadOf rewrites, which can hide the host.
  url="$(git -C "$repo" config --get "remote.$remote.url")"
  sshhost="$(sed -E 's#^[a-z+]+://##; s#^[^@/]*@##; s#[:/].*$##' <<<"$url")"
  case "$sshhost" in
    github.com|*.github.com) host=github ;;
    gitlab.com) host=gitlab ;;
    *) if [ -f "$HOME/.config/glab-cli/config.yml" ] && grep -qE "^[[:space:]]+${sshhost//./\\.}:" "$HOME/.config/glab-cli/config.yml"; then host=gitlab
       elif grep -qi gitlab <<<"$url"; then host=gitlab
       else host=unknown; note "remote host $sshhost is neither github.com nor a known GitLab: ask the user which it is."; fi ;;
  esac
fi
kv REMOTE "$remote"; kv REMOTE_URL "$url"; kv REMOTE_HOST "$sshhost"; kv HOST "$host"
if [ "$host" = gitlab ] && [ -f "$HOME/.config/glab-cli/config.yml" ]; then
  api="$(awk -v h="$sshhost:" '$1==h{f=1;next} f&&/^  [^ ]/{f=0} f&&$1=="api_host:"{print $2; exit}' "$HOME/.config/glab-cli/config.yml")"
  [ -n "$api" ] && [ "$api" != "$sshhost" ] && kv GITLAB_API_HOST "$api"
fi

default=""
[ -n "$remote" ] && default="$(git -C "$repo" symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null | sed "s#^$remote/##")"
[ -z "$default" ] && [ -n "$remote" ] && default="$(timeout 15 git -C "$repo" ls-remote --symref "$remote" HEAD 2>/dev/null | awk '/^ref:/{sub("refs/heads/","",$2); print $2; exit}')"
if [ -z "$default" ]; then for b in main master trunk develop; do git -C "$repo" show-ref -q --verify "refs/heads/$b" && { default="$b"; break; }; done; fi
if ! git -C "$repo" rev-parse -q --verify HEAD >/dev/null; then
  default="${default:-$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null)}"
  note "the repository has no commits yet: make an initial commit (and push it, if it has a remote) before setting Shoemaker up."
fi
kv DEFAULT_BRANCH "$default"
kv CURRENT_BRANCH "$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || echo detached)"
[ -n "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ] && note "the main checkout has uncommitted changes (fine: runs use their own worktree, but the checkout will not be fast-forwarded)."

# --- CI ---------------------------------------------------------------------------------------
ref="$default"; [ -n "$remote" ] && git -C "$repo" rev-parse -q --verify "$remote/$default" >/dev/null && ref="$remote/$default"
ci=""
git -C "$repo" ls-tree -r --name-only "$ref" -- .github/workflows 2>/dev/null | grep -Eq '\.ya?ml$' && ci="$ci github-actions"
git -C "$repo" cat-file -e "$ref:.gitlab-ci.yml" 2>/dev/null && ci="$ci gitlab-ci"
for f in .circleci/config.yml Jenkinsfile .travis.yml azure-pipelines.yml bitbucket-pipelines.yml; do
  git -C "$repo" cat-file -e "$ref:$f" 2>/dev/null && ci="$ci other:$f"
done
kv CI "${ci# }"
[ -z "$ci" ] && note "no CI: with GATE=ci, ship mode lands as review until CI exists; offer to set CI up (docs/ci.md)."

# --- stack and commands -------------------------------------------------------------------------
setup=""; verify=""; extra=""
if [ -f "$repo/package.json" ]; then
  if [ -f "$repo/pnpm-lock.yaml" ]; then setup="pnpm install --frozen-lockfile"; run="pnpm"
  elif [ -f "$repo/yarn.lock" ]; then setup="yarn install --frozen-lockfile"; run="yarn"
  elif [ -f "$repo/package-lock.json" ]; then setup="npm ci"; run="npm"
  else setup="npm install"; run="npm"; fi
  scripts="$(jq -r '.scripts // {} | keys[]' "$repo/package.json" 2>/dev/null | tr '\n' ' ')"
  case " $scripts " in *" test "*) verify="$run test" ;; esac
  for s in typecheck lint build; do case " $scripts " in *" $s "*) extra="$extra $run run $s;" ;; esac; done
  kv NODE_SCRIPTS "$scripts"
fi
if [ -f "$repo/pyproject.toml" ] || [ -f "$repo/setup.py" ] || ls "$repo"/requirements*.txt >/dev/null 2>&1; then
  if [ -f "$repo/uv.lock" ]; then setup="${setup:+$setup && }uv sync"; verify="${verify:+$verify && }uv run pytest"
  elif [ -f "$repo/poetry.lock" ]; then setup="${setup:+$setup && }poetry install"; verify="${verify:+$verify && }poetry run pytest"
  else verify="${verify:+$verify && }python -m pytest"; fi
fi
[ -f "$repo/Cargo.toml" ] && verify="${verify:+$verify && }cargo test"
[ -f "$repo/go.mod" ] && verify="${verify:+$verify && }go test ./..."
[ -z "$verify" ] && [ -f "$repo/Makefile" ] && grep -qE '^test:' "$repo/Makefile" && verify="make test"
if [ -z "$verify" ]; then
  t="$(ls "$repo"/tests/*.sh "$repo"/test/*.sh "$repo"/scripts/test*.sh 2>/dev/null | head -1)"
  [ -n "$t" ] && verify="bash ${t#$repo/}"
fi
kv SETUP_CMD "$setup"; kv VERIFY_CMD "$verify"; kv VERIFY_EXTRA "${extra# }"
[ -z "$verify" ] && note "no test command found: ask the user what proves a change works; without checks, stay in suggest or review mode."

# --- the repository's own agent tooling ---------------------------------------------------------------
agent=""; for f in AGENTS.md CLAUDE.md CONTRIBUTING.md .claude/settings.json; do [ -e "$repo/$f" ] && agent="$agent $f"; done
kv AGENT_FILES "${agent# }"
[ -d "$repo/.claude/skills" ] && kv REPO_SKILLS "$(ls "$repo/.claude/skills" | tr '\n' ' ')"
land="$(grep -rlE --include='*.sh' --include='*.mjs' --include='*.js' --include='*.py' 'glab mr create|gh pr create|merge_when_pipeline_succeeds|gh pr merge' "$repo/scripts" "$repo/private" "$repo/tools" 2>/dev/null | head -5 | tr '\n' ' ')"
[ -n "$land" ] && { kv LANDING_SCRIPTS "$land"; note "the repo has its own landing tooling ($land): consider LAND_CMD/GUARD_CMD in shoemaker.conf instead of shoemaker land."; }
kv HOOKS_PATH "$(git -C "$repo" config --get core.hooksPath || true)"
[ -d "$repo/.husky" ] && kv HUSKY 1

# --- this machine ------------------------------------------------------------------------------------------
kv GIT_USER "$(git -C "$repo" config user.name || true) <$(git -C "$repo" config user.email || true)>"
git -C "$repo" config user.email >/dev/null || note "no Git identity for this repo: runs cannot commit until the user chooses one."
for t in claude git jq flock timeout gh glab node npm python3 systemctl; do printf 'TOOL_%s=%q\n' "$t" "$(command -v "$t" || true)"; done
if [ "$host" = github ]; then
  if command -v gh >/dev/null && (cd "$repo" && timeout 20 gh repo view --json name >/dev/null 2>&1); then kv HOST_AUTH ok; else kv HOST_AUTH missing; note "gh cannot reach this repo yet: the user runs `shoemaker login` in their own terminal."; fi
elif [ "$host" = gitlab ]; then
  if command -v glab >/dev/null && (cd "$repo" && timeout 20 glab api user >/dev/null 2>&1); then kv HOST_AUTH ok; else kv HOST_AUTH missing; note "glab cannot reach this repo yet: the user runs `shoemaker login` in their own terminal."; fi
  glabs="$(type -ap glab 2>/dev/null | xargs -r -n1 readlink -f | awk '!seen[$0]++' | while read -r g; do echo "$g=$("$g" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; done)"
  [ "$(cut -d= -f2 <<<"$glabs" | sort -u | wc -l)" -gt 1 ] && note "glab versions differ on PATH ($(tr '\n' ' ' <<<"$glabs")): the first wins, and an old one can fail on a config a newer one wrote."
fi
kv SYSTEMD_USER "$(systemctl --user is-system-running 2>/dev/null || echo unavailable)"
kv LINGER "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ] || note "systemd linger is off: user timers stop when the user logs out (sudo loginctl enable-linger $USER, the user's call)."
kv TIMEZONE "$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"

for n in "${notes[@]}"; do echo "NOTE: $n"; done
exit 0
