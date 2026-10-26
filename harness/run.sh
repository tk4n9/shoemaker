#!/usr/bin/env bash
# run.sh — one round of Shoemaker's agents for one project. Started by the
# systemd timer through `shoemaker run`, or by hand.
#
#   shoemaker run                    run with DIRECTION.md's settings
#   shoemaker run --mode suggest     override the mode for this round: suggest | review | ship
#   shoemaker run --only approve     run one agent only: suggest | implement | approve
#   shoemaker run --dry-run          preflight, decisions and prompts only; no agent, nothing claimed
#   shoemaker run --force            run even when DIRECTION.md says enabled: false
#   shoemaker run --model sonnet --effort high   override model / effort for all agents
#
# A round runs agents side by side. The only thing connecting them is the queue:
#   suggestion agent      adds ideas toward DIRECTION.md for the human to review,
#                         while fewer than max_waiting wait (SUGGEST.md)
#   implementation agent  builds the next approved, ready items (IMPLEMENT.md), up to
#                         max_builds side by side, never two whose specs name the same
#                         file; not started at all when nothing approved is ready
#   auto-approval agent   when enabled on Todos, reviews the round-start snapshot
#                         in a read-only worktree (APPROVE.md). The runner applies
#                         approvals with Auto priority; holds wait for changes.
# The approver uses SUGGEST_TIMEOUT and one MAX_AGENTS slot, even with a team.
# Its approve_model/approve_effort fall back to model/effort and Claude defaults.
# Before them, the runner marks the items whose PR has merged or closed.
#
# Settings: shoemaker.conf (project, host, gate, commands) and DIRECTION.md's front
# matter. Model and effort: --model/--effort, else DIRECTION.md, else
# SHOEMAKER_MODEL/SHOEMAKER_EFFORT, else your Claude Code default.
# Each build works in a fresh worktree and publishes only through the merge gate
# (land.sh, or the repo's LAND_CMD). This script never pushes, merges or edits the
# repository's tracked files itself.

set -uo pipefail

SHOEMAKER_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STATE="${SHOEMAKER_STATE:-}"
[ -n "$STATE" ] && [ -f "$STATE/shoemaker.conf" ] || { echo "run.sh: set SHOEMAKER_STATE to a project's state directory (or use: shoemaker run)" >&2; exit 2; }
STATE="$(cd "$STATE" && pwd -P)"
# shellcheck disable=SC1091
. "$STATE/shoemaker.conf"
HARNESS="$SHOEMAKER_HOME/harness"
DIRECTION="$STATE/DIRECTION.md" RULES="$STATE/RULES.md" LEDGER="$STATE/LEDGER.md"
WT_ROOT="$STATE/worktrees" SETTINGS="$STATE/guard/claude-settings.json"
TIMEOUT="${SHOEMAKER_TIMEOUT:-${TIMEOUT:-5h}}"
SUGGEST_TIMEOUT="${SHOEMAKER_SUGGEST_TIMEOUT:-${SUGGEST_TIMEOUT:-1h}}"
PERM="${SHOEMAKER_PERMISSION_MODE:-${PERMISSION_MODE:-bypassPermissions}}"
KEEP_DAYS="${SHOEMAKER_KEEP_DAYS:-${KEEP_DAYS:-60}}"
BRANCH_PREFIX="${BRANCH_PREFIX:-shoemaker/}"
LAND="${LAND_CMD:-shoemaker land}"
MAX_AGENTS="${MAX_AGENTS:-16}"

mode_override="" model_override="" effort_override="" only="" dry_run=0 force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) mode_override="${2:-}"; shift 2 ;;
    --only) only="${2:-}"; shift 2 ;;
    --model) model_override="${2:-}"; shift 2 ;;
    --effort) effort_override="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$only" in ""|suggest|implement|approve) ;; *) echo "run.sh: --only takes suggest, implement or approve" >&2; exit 2 ;; esac

say() { printf '%s shoemaker[%s]: %s\n' "$(date '+%F %T')" "$PROJECT" "$*" | tee -a "${RUNLOG:-/dev/null}"; }
die() { say "ERROR: $*"; exit 1; }
Q() { SHOEMAKER_STATE="$STATE" SHOEMAKER_AUTHOR="${SHOEMAKER_AUTHOR:-runner}" node "$SHOEMAKER_HOME/dashboard/bin/queue.mjs" "$@"; }
# Worktree and fetch commands on the shared repository, one at a time: builds side by
# side would otherwise race on its lock files.
gitl() { flock "$STATE/.git.lock" git "$@"; }

# One round at a time: a slow round must not overlap the next timer firing.
exec 9>"$STATE/.lock"
flock -n 9 || { echo "shoemaker[$PROJECT]: another round holds $STATE/.lock; exiting."; exit 0; }

# --- DIRECTION.md front matter -----------------------------------------------------
front() {  # front <key>: a key's value in the leading --- block, comment stripped
  awk -v k="$1" 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{exit}
    NR>1 { sub(/#.*/, ""); if ($1 == k":") { $1=""; gsub(/^ +| +$/, ""); print; exit } }' "$DIRECTION"
}
check_effort() { case "$1" in ""|low|medium|high|xhigh|max) ;; *) die "effort must be low, medium, high, xhigh or max (got '$1')" ;; esac; }
[ -f "$DIRECTION" ] || die "missing $DIRECTION"
enabled="$(front enabled)"; mode="${mode_override:-$(front mode)}"; mode="${mode:-suggest}"
[ "$mode" = propose ] && mode=suggest   # the name in nightly-agent v1
case "$mode" in suggest|review|ship) ;; *) die "mode must be suggest, review or ship (got '$mode')" ;; esac
model="${model_override:-$(front model)}"; model="${model:-${SHOEMAKER_MODEL:-}}"
effort="${effort_override:-$(front effort)}"; effort="${effort:-${SHOEMAKER_EFFORT:-}}"
s_model="${model_override:-$(front suggest_model)}"; s_model="${s_model:-$model}"
s_effort="${effort_override:-$(front suggest_effort)}"; s_effort="${s_effort:-$effort}"
a_model="${model_override:-$(front approve_model)}"; a_model="${a_model:-$model}"
a_effort="${effort_override:-$(front approve_effort)}"; a_effort="${a_effort:-$effort}"
check_effort "$effort"; check_effort "$s_effort"; check_effort "$a_effort"
max_waiting="$(front max_waiting)"; max_waiting="${max_waiting:-5}"
per_round="$(front per_round)"; per_round="${per_round:-3}"
max_builds="$(front max_builds)"; max_builds="${max_builds:-1}"
case "$max_waiting$per_round$max_builds" in *[!0-9]*) die "max_waiting, per_round and max_builds must be whole numbers" ;; esac
[ "$max_builds" -ge 1 ] || die "max_builds must be at least 1"
if [ "$enabled" = "false" ] && [ "$force" = 0 ] && [ "$dry_run" = 0 ]; then
  echo "shoemaker[$PROJECT]: DIRECTION.md says enabled: false; nothing to do (--force overrides)."; exit 0
fi

# --- run directory -------------------------------------------------------------------
run_id="$(date +%Y-%m-%d-%H%M)"; [ "$dry_run" = 1 ] && run_id="$run_id-dry"
# Unique even for a second round within the same minute (a manual run after the timer's).
id_base="$run_id" n=1
while [ -e "$STATE/runs/$run_id" ] || grep -q "^### $run_id[- ]" "$LEDGER" 2>/dev/null; do n=$((n + 1)); run_id="$id_base-r$n"; done
RUN_DIR="$STATE/runs/$run_id"; mkdir -p "$RUN_DIR"; RUNLOG="$RUN_DIR/run.log"
say "round $run_id: mode $mode${mode_override:+ (override)}${only:+, only $only}, dry-run $dry_run"

# Snapshot once: confirmation can replace active.json while this round is running.
case "$MAX_AGENTS" in ""|*[!0-9]*) die "MAX_AGENTS must be a positive whole number" ;; esac
[ "$MAX_AGENTS" -ge 1 ] && [ "$MAX_AGENTS" -le 128 ] || die "MAX_AGENTS must be from 1 to 128"
team_active=0
if [ -f "$STATE/team/active.json" ]; then
  team_active=1
  team_config="$(node "$SHOEMAKER_HOME/dashboard/bin/team.mjs" validate "$STATE/team/active.json" "$MAX_AGENTS")" \
    || die "active team config is invalid; no agent started"
  printf '%s\n' "$team_config" >"$RUN_DIR/team.json"
fi

# --- preflight -----------------------------------------------------------------------
tools="claude git jq node timeout flock"
case "$HOST" in github) host_cli=gh ;; gitlab) host_cli=glab ;; none) host_cli="" ;; *) die "HOST must be github, gitlab or none (got '$HOST')" ;; esac
for t in $tools; do command -v "$t" >/dev/null || die "$t not on PATH ($PATH)"; done
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "no repository at $REPO"
Q stats --json >/dev/null 2>>"$RUNLOG" || die "the queue does not answer ($STATE/queue.db; see shoemaker doctor)"
# Read the switch and eligible ideas once. A mid-round dashboard change is for
# the next round, and new suggestions are never added to this snapshot.
Q approval --json >"$RUN_DIR/approval.json" 2>>"$RUNLOG" || die "cannot snapshot auto approval"
if [ "$HOST" = none ]; then
  base="$DEFAULT_BRANCH"
else
  timeout 60 git -C "$REPO" fetch -q "$REMOTE" "$DEFAULT_BRANCH" || die "git fetch $REMOTE $DEFAULT_BRANCH failed (network or SSH key)"
  base="$REMOTE/$DEFAULT_BRANCH"
fi
base_sha="$(git -C "$REPO" rev-parse --verify -q "$base")" || die "no $base in $REPO"

# A round that cannot publish runs only the suggestion agent: work left on a branch
# with no PR rots while others keep merging (seen in practice: 200+ commits behind,
# conflicts resolved by hand).
host_ok=0 impl_off="" notes=""
case "$HOST" in
  github)
    if ! command -v gh >/dev/null; then impl_off="gh is not installed"
    elif ! ( cd "$REPO" && timeout 30 gh repo view --json name >/dev/null 2>&1 ); then
      impl_off="gh cannot reach this repository (not logged in, or no access; run: shoemaker login)"
    else
      host_ok=1
      exp="$(cd "$REPO" && timeout 30 gh api -i user 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="github-authentication-token-expiration"{print $2}')"
    fi ;;
  gitlab)
    if ! command -v glab >/dev/null; then impl_off="glab is not installed"
    elif ! ( cd "$REPO" && timeout 30 glab api user >/dev/null 2>&1 ); then
      impl_off="glab cannot reach GitLab for this clone's remote (expired token or no host entry; run: shoemaker login)"
    else
      host_ok=1
      exp="$(cd "$REPO" && timeout 30 glab api personal_access_tokens/self 2>/dev/null | jq -r '.expires_at // empty' 2>/dev/null || true)"
    fi ;;
esac
# Say so two weeks before the token lapses, while there is time to renew it.
if [ -n "${exp:-}" ] && exp_s="$(date -d "$exp" +%s 2>/dev/null)" && days_left=$(( (exp_s - $(date +%s)) / 86400 )) && [ "$days_left" -le 14 ]; then
  notes="$notes the $HOST token expires on $exp ($days_left days): tell the human to renew it with \`shoemaker login\`, at the top of summary.md;"
  say "WARNING: the $HOST token expires on $exp ($days_left days); renew it with: shoemaker login"
fi
# No Git identity means no commit, so the agent would build a change it cannot keep
# (seen in practice: a whole run of work stranded). Choosing one is the human's call.
git -C "$REPO" config user.email >/dev/null \
  || impl_off="${impl_off:+$impl_off; }no Git identity (user.name/user.email) for $REPO, so nothing can be committed"
[ "$mode" = suggest ] && impl_off="mode is suggest"
[ -n "$impl_off" ] && [ "$mode" != suggest ] && say "WARNING: $impl_off; no implementation this round"
# Say up front when ship cannot merge here; land.sh enforces the same rule.
if [ "$mode" = ship ] && [ -z "${LAND_CMD:-}" ]; then
  case "$GATE" in
    ci)
      ci=0
      case "$HOST" in
        github) git -C "$REPO" ls-tree -r --name-only "$base" -- .github/workflows | grep -Eq '\.ya?ml$' && ci=1 ;;
        gitlab) git -C "$REPO" cat-file -e "$base:.gitlab-ci.yml" 2>/dev/null && ci=1 ;;
      esac
      [ "$ci" = 1 ] || { notes="$notes GATE=ci but $DEFAULT_BRANCH has no CI (or there is no remote), so land.sh opens PRs for review instead of merging: say so in summary.md;"; say "NOTE: no CI to gate merges; ship lands as review"; } ;;
    none) notes="$notes GATE=none: land.sh never merges, so changes go to review;" ;;
  esac
fi

# Bring the main checkout up to date: the repo's own SYNC_CMD, or a fast-forward
# when it is a clean default branch. Never anything that could lose work.
sync_main() {
  if [ -n "${SYNC_CMD:-}" ]; then
    ( cd "$REPO" && bash -c "$SYNC_CMD" ) >>"$RUNLOG" 2>&1 && say "main checkout: SYNC_CMD done" || say "main checkout: SYNC_CMD failed (see run.log)"
  elif [ "${SYNC_MAIN:-1}" = 1 ] && [ "$HOST" != none ]; then
    if [ "$(git -C "$REPO" symbolic-ref --quiet --short HEAD)" = "$DEFAULT_BRANCH" ] \
       && [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
      gitl -C "$REPO" merge -q --ff-only "$base" >>"$RUNLOG" 2>&1 \
        && say "main checkout at $base $(git -C "$REPO" rev-parse --short=12 "$base")" || say "main checkout has diverged from $base; left as is"
    else
      say "main checkout is not a clean $DEFAULT_BRANCH; left as is"
    fi
  fi
}
[ "$dry_run" = 0 ] && sync_main

# --- the publish guard (GUARD=1): refuse to start unless it is really in place -----------
# (Seen in practice: hooks moved in a refactor, and a stale path silently disabled them.)
claude_guard=()
# The read-only approver uses the same protected context as team reviewers.
if [ "$team_active" = 1 ] || jq -e '.enabled' "$RUN_DIR/approval.json" >/dev/null; then
  git -C "$REPO" config extensions.worktreeConfig true
fi
if [ "${GUARD:-1}" = 1 ]; then
  if [ -n "${GUARD_CMD:-}" ]; then
    ( cd "$REPO" && bash -c "$GUARD_CMD" ) >>"$RUNLOG" 2>&1 || die "the repository's guard installer failed: $GUARD_CMD"
  fi
  # Worktree-scoped settings, so the guard's hooks and tags apply to the agents' worktrees only.
  git -C "$REPO" config extensions.worktreeConfig true
  mkdir -p "$STATE/guard"
  jq -n --arg c "$(printf '%q %q' "$HARNESS/guard/claude-guard.sh" "$STATE")" \
    '{hooks: {PreToolUse: [{matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{type: "command", command: $c}]}]}}' >"$SETTINGS"
  claude_guard=(--settings "$SETTINGS")
fi
# guard_worktree <path> <role>: point a fresh worktree at the guard hooks (unless the
# repo installs its own) and check that the hooks are really there.
guard_worktree() {
  local wt="$1" role="$2" hooks
  [ "${GUARD:-1}" = 1 ] || return 0
  git -C "$wt" config --worktree shoemaker.state "$STATE" && git -C "$wt" config --worktree shoemaker.role "$role" \
    || { say "ERROR: could not tag $wt for the guard"; return 1; }
  [ -n "${GUARD_CMD:-}" ] || git -C "$wt" config --worktree core.hooksPath "$HARNESS/guard/git-hooks"
  hooks="$(git -C "$wt" config --get core.hooksPath || true)"
  case "$hooks" in /*) ;; "") hooks="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)/hooks" ;; *) hooks="$(git -C "$wt" rev-parse --show-toplevel)/$hooks" ;; esac
  [ -x "$hooks/pre-push" ] && [ -x "$hooks/pre-commit" ] || { say "ERROR: no push guard in $wt (core.hooksPath → $hooks)"; return 1; }
}

# --- remove finished worktrees -------------------------------------------------------------
# Only ours, only when nothing can be lost: no changes, no untracked files, and HEAD
# already in the default branch. Anything else is kept for the next round.
cleanup_worktree() {  # cleanup_worktree <path>
  local wt="$1" br
  [ -d "$wt" ] || return 0
  [ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ] || { say "keeping $wt (uncommitted or untracked changes)"; return 0; }
  git -C "$wt" merge-base --is-ancestor HEAD "$base" 2>/dev/null || { say "keeping $wt (commits not in $base)"; return 0; }
  br="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  gitl -C "$REPO" worktree unlock "$wt" 2>/dev/null || true
  gitl -C "$REPO" worktree remove --force "$wt" && say "removed finished worktree $wt"
  case "$br" in "$BRANCH_PREFIX"*) gitl -C "$REPO" branch -D "$br" >/dev/null 2>&1 || true ;; esac
}
mkdir -p "$WT_ROOT"
while IFS= read -r wt; do
  case "$wt" in "$WT_ROOT"/*) cleanup_worktree "$wt" ;; esac
done < <(git -C "$REPO" worktree list --porcelain | sed -n 's/^worktree //p')
gitl -C "$REPO" worktree prune 2>/dev/null || true

# --- reconcile the queue with the host ------------------------------------------------------
# An item waiting on its PR (a draft for the human, or a merge still running when the
# last round ended) ships once that PR has merged, so the items that need it can start.
# A failed item whose PR merged after all ships too.
pr_state() {  # pr_state <url>: merged | closed | open | unknown
  local s iid
  case "$HOST" in
    github) s="$(cd "$REPO" && timeout 30 gh pr view "$1" --json state --jq .state 2>/dev/null)" ;;
    gitlab) iid="$(sed -nE 's#.*/merge_requests/([0-9]+).*#\1#p' <<<"$1")"
            [ -n "$iid" ] && s="$(cd "$REPO" && timeout 30 glab api "projects/:id/merge_requests/$iid" 2>/dev/null | jq -r '.state // empty')" ;;
  esac
  case "${s:-}" in MERGED|merged) echo merged ;; CLOSED|closed) echo closed ;; OPEN|opened) echo open ;; *) echo unknown ;; esac
}
if [ "$dry_run" = 0 ]; then
  # Fields split on \x1f, not tabs: bash merges runs of tab separators, so an empty
  # field would shift the next one into its place.
  while IFS=$'\x1f' read -r id status url branch; do
    [ -n "$id" ] || continue
    if [ -n "$url" ] && [ "$host_ok" = 1 ]; then
      case "$(pr_state "$url")" in
        merged) Q merged "$id" --note "(seen at round $run_id)" >/dev/null && say "queue: #$id shipped (its PR merged)" ;;
        closed) [ "$status" = failed ] || { Q fail "$id" --note "its PR was closed without merging: $url" >/dev/null \
                  && say "queue: #$id failed (its PR was closed)"; } ;;
      esac
    elif [ "$HOST" = none ] && [ -z "$url" ] && [ -n "$branch" ] && [ "$status" = review ]; then
      # No remote: a branch left for the human has shipped once the default branch contains it.
      if git -C "$REPO" rev-parse -q --verify "refs/heads/$branch" >/dev/null \
         && git -C "$REPO" merge-base --is-ancestor "refs/heads/$branch" "$DEFAULT_BRANCH"; then
        Q merged "$id" --note "(branch $branch is in $DEFAULT_BRANCH; seen at round $run_id)" >/dev/null && say "queue: #$id shipped ($branch merged)"
      fi
    fi
  done < <(Q list --status in_progress,review,failed --json | jq -r '.[] | select(.pr_url != null or .branch != null)
             | [(.id | tostring), .status, (.pr_url // ""), (.branch // "")] | join("\u001f")')
fi

common_paths() {
  printf -- '- project: %s, repository `%s` (host %s, default branch `%s`)\n' "$PROJECT" "$REPO" "$HOST" "$DEFAULT_BRANCH"
  printf -- '- Shoemaker state: `%s` (DIRECTION.md, RULES.md, LEDGER.md, shoemaker.conf)\n' "$STATE"
  printf -- '- the queue: `shoemaker queue` (`shoemaker queue help` lists its commands)%s\n' "${DASHBOARD_URL:+; the human reviews it at $DASHBOARD_URL}"
  [ -n "${UMBRELLA:-}" ] && printf -- '- umbrella workspace: `%s` (its README.md and agent instructions, if present)\n' "$UMBRELLA"
  printf -- '- status log: %s\n' "$( [ -n "${STATUSLOG:-}" ] && printf '`%s` (append your entry)' "$STATUSLOG" || echo "none (skip that record)")"
}
quoted_files() {
  printf '\n---\n\n# RULES.md (human-owned project rules; quoted)\n\n'
  if [ -f "$RULES" ]; then cat "$RULES"; else echo "(none)"; fi
  printf '\n---\n\n# DIRECTION.md (human-owned; quoted)\n\n'
  cat "$DIRECTION"
}
model_args() {  # model_args <model> <effort>
  [ -n "$1" ] && printf '%s\0' --model "$1"
  [ -n "$2" ] && printf '%s\0' --effort "$2"
}
# agent <timeout> <dir> <author> <claude args...>: claude in <dir> with the round's environment
agent() {
  local t="$1" dir="$2" who="$3" dirs=(--add-dir "$STATE") env=()
  shift 3
  [ -n "${UMBRELLA:-}" ] && dirs+=(--add-dir "$UMBRELLA")
  # shellcheck disable=SC2206
  [ -n "${AGENT_ENV:-}" ] && env=($AGENT_ENV)
  [ -n "${team_context:-}" ] && env+=("SHOEMAKER_TEAM_CONTEXT=$team_context")
  ( cd "$dir" && env "${env[@]}" PATH="$SHOEMAKER_HOME/bin:$PATH" SHOEMAKER_STATE="$STATE" SHOEMAKER_AUTHOR="$who" \
      SHOEMAKER_MODE="$mode" SHOEMAKER_RUN_ID="$run_id" \
      timeout --kill-after=2m "$t" claude "$@" "${claude_guard[@]}" --permission-mode "$PERM" "${dirs[@]}" \
        --output-format stream-json --verbose )
}
result_stats() {  # result_stats <dir>: result.md and a one-line summary in $stats
  jq -r 'select(.type=="result") | .result // empty' "$1/transcript.jsonl" 2>/dev/null | tail -n 1 >"$1/result.md"
  stats="$(jq -r 'select(.type=="result") | "subtype=\(.subtype) turns=\(.num_turns) cost_usd=\(.total_cost_usd // "n/a") is_error=\(.is_error)"' \
    "$1/transcript.jsonl" 2>/dev/null | tail -n 1)"
}

build_vars() {  # build_vars <index>: sets ij item_id B BDIR WT BRANCH
  ij="$(jq -c ".items[$1]" <<<"$picks")"
  item_id="$(jq -r '.item.id' <<<"$ij")"
  B="$run_id-q$item_id" BDIR="$RUN_DIR/q$item_id"
  if [ "$team_active" = 1 ]; then
    BDIR="${team_build_dirs[$1]}"
    team_context="${team_build_contexts[$1]}"
    model="${team_build_models[$1]}" effort="${team_build_efforts[$1]}"
  fi
  WT="$WT_ROOT/$B" BRANCH="${BRANCH_PREFIX}q$item_id-$run_id"
}

write_impl_prompt() {
  local others
  others="$(jq -r --argjson me "$item_id" '[.items[] | select(.item.id != $me) | "#\(.item.id)"] | join(", ")' <<<"$picks")"
  {
    printf '# Shoemaker round %s: implementation agent\n\n' "$B"
    printf -- '- mode: **%s**\n' "$mode"
    printf -- '- your item: **#%s %s**, %s\n' "$item_id" "$(jq -r '.item.title' <<<"$ij")" \
      "$(jq -r 'if .resume then "a **resume** (attempt \(.item.attempts) of 3; its log says how far it got)" else "**new** (attempt \(.item.attempts) of 3)" end' <<<"$ij")"
    jq -r '.item | select(.branch or .pr_url) | "- an earlier attempt left: " + ([(.branch // empty | "branch `\(.)`"), (.pr_url // empty | "PR \(.)")] | join(", "))' <<<"$ij"
    [ -n "$others" ] && printf -- '- side by side: round %s also builds %s, each with its own agent, worktree and branch. They are not yours: leave their worktrees, branches, PRs and queue items alone. Shared files (LEDGER.md, the status log) are append-only.\n' "$run_id" "$others"
    printf -- '- model: %s; effort: %s\n' "${model:-Claude Code default}" "${effort:-Claude Code default}"
    printf -- '- worktree (your working directory): `%s`\n' "$WT"
    printf -- '- branch: `%s`, from %s `%s`; rename it to `%sq%s-<short-slug>` before the first commit\n' "$BRANCH" "$base" "$base_sha" "$BRANCH_PREFIX" "$item_id"
    printf -- '- gate: %s; setup: `%s`; verify: `%s`\n' "$GATE" "${SETUP_CMD:-none}" "${VERIFY_CMD:-none}"
    printf -- '- publish with: `%s`%s\n' "$LAND" "$( [ -n "${LAND_CMD:-}" ] && echo " (the repository's own landing command; RULES.md says how to use it)")"
    common_paths
    printf -- '- run directory, for proposal.md and summary.md: `%s`\n' "$BDIR"
    printf -- '- deadline: %s (the process is killed then)\n' "$(deadline "$TIMEOUT")"
    [ -n "$notes" ] && printf -- '- notes:%s\n' "$notes"
    printf '\n## Your item (`shoemaker queue show %s`)\n\n```text\n' "$item_id"
    Q show "$item_id"
    printf '```\n\n'
    if [ "$team_active" = 1 ]; then
      printf '\n## Confirmed team role\n\n'
      jq -r '"Role: " + .role_name + "\nCapabilities: build\n\n" + .instructions' "$team_context"
    fi
    cat "$HARNESS/IMPLEMENT.md"
    quoted_files
  } > "$BDIR/prompt.md"
}

to_seconds() { case "$1" in *h) echo $(( ${1%h} * 3600 )) ;; *m) echo $(( ${1%m} * 60 )) ;; *s) echo "${1%s}" ;; *) echo "$1" ;; esac; }

# One build, start to finish; run in the background, one per item.
run_build() {  # run_build <index>
  local rc started elapsed no_start turns why sid left margs=()
  build_vars "$1"
  while IFS= read -r -d '' a; do margs+=("$a"); done < <(model_args "$model" "$effort")
  say "#$item_id: starting claude in $WT on $BRANCH (mode $mode, model ${model:-default}, effort ${effort:-default}, timeout $TIMEOUT)"
  started="$(date +%s)"
  agent "$TIMEOUT" "$WT" "implementation agent" -p "$(cat "$BDIR/prompt.md")" \
    --name "shoemaker-$PROJECT-$B" "${margs[@]}" >"$BDIR/transcript.jsonl" 2>"$BDIR/stderr.log"
  rc=$?
  elapsed=$(( $(date +%s) - started )); result_stats "$BDIR"
  [ "$rc" = 124 ] && say "#$item_id: hit the $TIMEOUT timeout"
  say "#$item_id: claude exited $rc after $((elapsed / 60)) min; ${stats:-no result event}"

  # An agent that never got going (a usage limit or a broken install: seven rounds
  # in a row once ended so, at once) did no work on the item, so the attempt is given
  # back instead of spent, and no crash is recorded.
  no_start=0
  turns="$(jq -r 'select(.type=="result") | .num_turns // 0' "$BDIR/transcript.jsonl" 2>/dev/null | tail -n 1)"
  if [ "$rc" != 0 ] && [ "$rc" != 124 ] && [ "${turns:-0}" -le 1 ]; then
    why="$(jq -r 'select(.type=="result") | .result // empty' "$BDIR/transcript.jsonl" 2>/dev/null | tail -n 1 | head -c 160)"
    [ -n "$why" ] || why="$(head -n 1 "$BDIR/stderr.log" 2>/dev/null | head -c 160)"
    Q release "$item_id" --note "run $B could not start the agent (claude exit $rc${why:+: $why})" >/dev/null 2>&1 || true
    say "#$item_id: the agent did not start (exit $rc, ${turns:-0} turns); its attempt is given back"
    no_start=1
  fi

  # `claude -p` exits when the agent ends its turn, so an agent that ended it to wait
  # on something in the background never comes back (seen in practice: the PR merged,
  # nothing was recorded). If it ended cleanly without its ledger entry, resume the
  # same session once, within what is left of the timeout.
  if [ "$rc" = 0 ] && ! grep -q "^### $B " "$LEDGER"; then
    sid="$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id // empty' "$BDIR/transcript.jsonl" 2>/dev/null | head -n 1)"
    left=$(( $(to_seconds "$TIMEOUT") - elapsed ))
    if [ -n "$sid" ] && [ "$left" -gt 300 ]; then
      say "#$item_id: no ledger entry yet; resuming session $sid once ($((left / 60)) min left)"
      agent "$left" "$WT" "implementation agent" -p "You ended your turn before this run was finished, so the run stopped: in this headless run (claude -p) ending a turn ends the process, and background tasks never notify you. Start no new work. Find where you left off (your queue item #$item_id with \`shoemaker queue show $item_id\`, the PR with \`$LAND status\`, the worktree, the run directory $BDIR). If something is still pending, wait for it in the foreground in bounded steps (IMPLEMENT.md, *This is a headless run*). Then do step 5: the queue update, the LEDGER.md entry headed '### $B — <outcome> — #$item_id <title>' (appended with cat >>), summary.md, and the status log entry if there is one. Your final message ends the run." \
        --resume "$sid" "${margs[@]}" >>"$BDIR/transcript.jsonl" 2>>"$BDIR/stderr.log"
      rc=$?
      elapsed=$(( $(date +%s) - started )); result_stats "$BDIR"
      say "#$item_id: resumed session exited $rc; $((elapsed / 60)) min in total; ${stats:-no result event}"
    fi
  fi

  [ "$HOST" != none ] && { gitl -C "$REPO" fetch -q "$REMOTE" "$DEFAULT_BRANCH" 2>/dev/null || true; }
  gitl -C "$REPO" worktree unlock "$WT" 2>/dev/null || true
  cleanup_worktree "$WT"

  if [ "$no_start" = 0 ] && ! grep -q "^### $B " "$LEDGER"; then
    say "#$item_id: the agent left no ledger entry; recording $B as crashed"
    Q note "$item_id" "Run $B ended without recording (claude exit $rc); the next round resumes this item." >/dev/null 2>&1 || true
    cat >>"$LEDGER" <<EOF

### $B — crashed — #$item_id $(jq -r '.item.title' <<<"$ij")
- PR: unknown (check the host for ${BRANCH_PREFIX}q$item_id-* branches); branch: \`$BRANCH\`
- notes: claude exit $rc after $((elapsed / 60)) min (${stats:-no result event}); see ${BDIR#"$STATE/"}/{stderr.log,transcript.jsonl} and runs/$run_id/run.log; worktree $( [ -d "$WT" ] && echo "kept at $WT" || echo removed ); the item stays in progress and the next round resumes it
EOF
  fi
  say "queue: #$item_id is now $(Q show "$item_id" --json | jq -r '.status')"
  return "$rc"
}

# --- decide what runs ------------------------------------------------------------------
deadline() { date -d "now + $(sed -E 's/h$/ hours/; s/m$/ minutes/; s/s$/ seconds/' <<<"$1")" '+%F %T %Z' 2>/dev/null || echo "in $1"; }

# The approver shares the team reviewers' restricted turn and result path.
. "$HARNESS/team-run.sh"
. "$HARNESS/approve-run.sh"
decide_approve

if [ "$team_active" = 1 ] && [ "$only" != approve ]; then
  # Team stages share the same preflight, worktrees, guard and build implementation.
  reserve_team_approve
  prepare_approve
  team_round
  exit $?
fi

waiting="$(Q stats --json | jq -r '.proposed')"
room=$(( max_waiting - waiting )); [ "$room" -lt 0 ] && room=0
ideas=$(( per_round < room ? per_round : room ))
want_suggest=0
if [ "$only" = implement ] || [ "$only" = approve ]; then say "suggestion agent: not this round (--only $only)"
elif [ "$ideas" -eq 0 ]; then say "suggestion agent: not this round ($waiting waiting for your review; max_waiting is $max_waiting)"
else want_suggest=1; say "suggestion agent: up to $ideas idea(s) ($waiting waiting for your review)"
fi
if [ "$want_approve" = 1 ] && [ "$want_suggest" -ge "$MAX_AGENTS" ]; then
  want_approve=0
  say "auto-approval agent: not this round (MAX_AGENTS is $MAX_AGENTS; suggestion uses the available slot)"
fi
prepare_approve

picks='{"items":[]}' want_impl=0 n_builds=0
if [ "$only" = suggest ] || [ "$only" = approve ]; then say "implementation agent: not this round (--only $only)"
elif [ -n "$impl_off" ]; then say "implementation agent: not this round ($impl_off)"
else
  available_builds=$(( MAX_AGENTS - want_suggest - want_approve ))
  [ "$max_builds" -gt "$available_builds" ] && max_builds="$available_builds"
  if [ "$max_builds" -eq 0 ]; then
    say "implementation agent: not this round (MAX_AGENTS is $MAX_AGENTS)"
  elif [ "$dry_run" = 1 ]; then picks="$(Q next --max "$max_builds" --json)"; else picks="$(Q pick --run "$run_id" --max "$max_builds" --json)"; fi
  n_builds="$(jq -r '.items | length' <<<"$picks" 2>/dev/null)"; n_builds="${n_builds:-0}"
  if [ "$n_builds" -gt 0 ]; then
    want_impl=1
    while IFS= read -r l; do say "implementation agent: $l"; done < <(jq -r '.items[]
      | "#\(.item.id) \(.item.title) (\(if .resume then "resume, attempt \(.item.attempts)" else "new" end))"' <<<"$picks")
    more="$(Q stats --json | jq -r '.ready')"
    [ "${more:-0}" -gt 0 ] && say "implementation agent: $more more ready item(s) wait for a later round (max_builds is $max_builds, and items that name the same files are never built side by side)"
  else
    say "implementation agent: not this round (nothing to build: $(jq -r '.why' <<<"$picks"))"
  fi
fi

if [ "$want_suggest" = 0 ] && [ "$want_impl" = 0 ] && [ "$want_approve" = 0 ]; then
  [ "$dry_run" = 1 ] && { say "dry run: no agent would start"; exit 0; }
  # An idle round leaves one line, not a run directory.
  { printf '%s ' "$run_id"; grep -E 'not this round|queue: #' "$RUNLOG" | sed 's/^.*\]: //' | paste -sd';' -; } >>"$STATE/runs/idle.log"
  rm -rf "$RUN_DIR"
  find "$STATE/runs" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null
  exit 0
fi

# --- the suggestion agent (in the background) --------------------------------------------
S_DIR="$RUN_DIR/suggest" S_WT="$WT_ROOT/$run_id-suggest" suggest_pid=""
if [ "$want_suggest" = 1 ]; then
  mkdir -p "$S_DIR"
  {
    printf '# Shoemaker round %s: suggestion agent\n\n' "$run_id"
    printf -- '- you may add: **up to %s idea(s)** this round (%s wait for the human'"'"'s review; max_waiting is %s)\n' "$ideas" "$waiting" "$max_waiting"
    printf -- '- model: %s; effort: %s\n' "${s_model:-Claude Code default}" "${s_effort:-Claude Code default}"
    printf -- '- your checkout (read-only; %s `%s`): `%s`\n' "$base" "$base_sha" "$S_WT"
    common_paths
    printf -- '- run directory, for your idea files and summary.md: `%s`\n' "$S_DIR"
    printf -- '- deadline: %s (the process is killed then)\n' "$(deadline "$SUGGEST_TIMEOUT")"
    [ -n "$notes" ] && printf -- '- notes:%s\n' "$notes"
    printf '\n'
    cat "$HARNESS/SUGGEST.md"
    quoted_files
  } > "$S_DIR/prompt.md"
fi

run_suggest() {
  local rc started added args=()
  while IFS= read -r -d '' a; do args+=("$a"); done < <(model_args "$s_model" "$s_effort")
  gitl -C "$REPO" worktree add -q --detach "$S_WT" "$base" >>"$RUNLOG" 2>&1 || { say "suggest: git worktree add $S_WT failed"; return 1; }
  gitl -C "$REPO" worktree lock --reason "shoemaker round $run_id (pid $$)" "$S_WT"
  guard_worktree "$S_WT" suggest || { gitl -C "$REPO" worktree unlock "$S_WT"; cleanup_worktree "$S_WT"; return 1; }
  say "suggest: starting claude (model ${s_model:-default}, effort ${s_effort:-default}, timeout $SUGGEST_TIMEOUT)"
  started="$(date +%s)"
  agent "$SUGGEST_TIMEOUT" "$S_WT" "suggestion agent" -p "$(cat "$S_DIR/prompt.md")" \
    --name "shoemaker-$PROJECT-$run_id-suggest" "${args[@]}" >"$S_DIR/transcript.jsonl" 2>"$S_DIR/stderr.log"
  rc=$?
  result_stats "$S_DIR"
  added="$(Q list --json | jq -r --arg r "$run_id" '[.[] | select(.run_id == $r) | "#\(.id)"] | join(", ")')"
  say "suggest: claude exited $rc after $(( ($(date +%s) - started) / 60 )) min; added: ${added:-nothing}; ${stats:-no result event}"
  [ -f "$S_DIR/summary.md" ] || say "suggest: WARNING: no summary.md"
  gitl -C "$REPO" worktree unlock "$S_WT" 2>/dev/null || true
  cleanup_worktree "$S_WT"
}

# --- the implementation agents (side by side, one per picked item) -----------------------
# Build <i> of this round: item #id, its own run id ($run_id-q<id>, which heads its
# ledger entry), directory, worktree and branch.
if [ "$want_impl" = 1 ]; then
  for ((i = 0; i < n_builds; i++)); do build_vars "$i"; mkdir -p "$BDIR"; write_impl_prompt; done
fi

if [ "$dry_run" = 1 ]; then
  # Check the guard on a throwaway worktree, as a real build would set it up.
  if [ "${GUARD:-1}" = 1 ]; then
    probe="$WT_ROOT/$run_id-probe"
    gitl -C "$REPO" worktree add -q --detach "$probe" "$base" >>"$RUNLOG" 2>&1 || die "git worktree add $probe failed"
    if guard_worktree "$probe" build; then say "publish guard: in place ($(git -C "$probe" config --get core.hooksPath) + claude-guard.sh)"; else probe_bad=1; fi
    cleanup_worktree "$probe"
    [ -z "${probe_bad:-}" ] || die "the publish guard is not in place; no agent would start"
  else
    say "publish guard: off (GUARD=0); the agents are only told to publish through the gate"
  fi
  say "dry run: prompts written$( [ "$want_suggest" = 1 ] && echo " ($S_DIR/prompt.md)")$( [ "$want_impl" = 1 ] && echo " ($RUN_DIR/q*/prompt.md)")$( [ "$want_approve" = 1 ] && echo " ($A_DIR/prompt.md)"); nothing claimed, no agent started"
  exit 0
fi

if [ "$want_suggest" = 1 ]; then
  run_suggest &
  suggest_pid=$!
fi
start_approve


rc=0 build_pids=()
if [ "$want_impl" = 1 ]; then
  for ((i = 0; i < n_builds; i++)); do
    build_vars "$i"
    # Worktrees are made one after another, before any agent starts.
    if ! gitl -C "$REPO" worktree add -q -b "$BRANCH" "$WT" "$base" >>"$RUNLOG" 2>&1; then
      say "ERROR: git worktree add $WT failed; #$item_id stays in progress for the next round"
      Q note "$item_id" "Run $B could not create its worktree; the next round tries again." >/dev/null 2>&1 || true
      rc=1; continue
    fi
    gitl -C "$REPO" worktree lock --reason "shoemaker round $run_id (pid $$)" "$WT"
    if ! guard_worktree "$WT" build; then
      Q note "$item_id" "Run $B found no push guard in its worktree, so the agent was not started; the next round tries again." >/dev/null 2>&1 || true
      gitl -C "$REPO" worktree unlock "$WT"; cleanup_worktree "$WT"; rc=1; continue
    fi
    run_build "$i" &
    build_pids+=("$!")
  done
  for pid in "${build_pids[@]}"; do wait "$pid" || rc=1; done
fi

if [ -n "$suggest_pid" ]; then
  wait "$suggest_pid" || true
fi
finish_approve || rc=1

[ "$want_impl" = 1 ] && sync_main
find "$STATE/runs" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null
say "done: $RUN_DIR"
exit "$rc"
