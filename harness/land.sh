#!/usr/bin/env bash
# land.sh — publish the current Shoemaker branch through the merge gate. Run it
# from the build's worktree, as `shoemaker land …`.
#
#   shoemaker land open [-t TITLE] [-F DESCRIPTION_FILE]
#       rebase on the default branch, push, open (or reuse) the PR/MR. In ship mode
#       with the local gate, also run VERIFY_CMD and merge at once.
#   shoemaker land wait [SECONDS]
#       wait up to SECONDS (default 540, under the 10-minute tool limit) for the
#       PR/MR's CI; merge it, pinned to the pushed commit, once every check passed.
#   shoemaker land status
#       one line: the PR/MR, its checks, merged or not.
#
# The mode comes from SHOEMAKER_MODE (the runner exports it; by hand it defaults
# to review): ship merges; review opens a draft PR/MR, or leaves the branch when
# there is no remote, for the human. GATE in shoemaker.conf says what must pass:
# ci (the PR/MR's checks; without CI in the repo, ship acts as review), local
# (VERIFY_CMD here, just before merging), none (never merge).
#
# GitHub: this never uses `gh pr merge --auto`, which merges at once on a repo
# without required checks. It polls the checks and merges itself.
#
# Exit: 0 merged (ship) / opened for review / nothing left to wait for
#       1 refused: default or non-Shoemaker branch, uncommitted changes, nothing to
#         land, a rebase conflict (files listed), PR/MR closed or moved
#       3 a git or host step failed (network, auth, permissions)
#       4 the gate failed: CI red, or VERIFY_CMD failed
#       5 still waiting: run `shoemaker land wait` again

set -uo pipefail

# The project's settings: from the runner's environment, or from the worktree,
# which the runner tags with its state directory.
STATE="${SHOEMAKER_STATE:-$(git config --get shoemaker.state 2>/dev/null)}"
[ -n "$STATE" ] && [ -f "$STATE/shoemaker.conf" ] || { echo "land: no Shoemaker state here (SHOEMAKER_STATE, or a worktree made by the runner)" >&2; exit 1; }
# shellcheck disable=SC1091
. "$STATE/shoemaker.conf"
BRANCH_PREFIX="${BRANCH_PREFIX:-shoemaker/}"
MODE="${SHOEMAKER_MODE:-review}"
POLL="${SHOEMAKER_LAND_POLL:-10}"

say() { echo "land: $*"; }
die() { local c="$1"; shift; echo "land: $*" >&2; exit "$c"; }

# A confirmed team's capabilities and round mode survive changes to the agent's
# environment. Ship may be lowered to review, but review cannot become ship.
team_context="$(git config --get shoemaker.teamContext 2>/dev/null || true)"
team_context="${team_context:-${SHOEMAKER_TEAM_CONTEXT:-}}"
if [ -n "$team_context" ]; then
  jq -e '.capabilities == ["build"]' "$team_context" >/dev/null 2>&1 \
    || die 1 "this team role has no build capability"
  team_mode="$(jq -er '.mode | select(. == "suggest" or . == "review" or . == "ship")' "$team_context")" \
    || die 1 "invalid mode in the team's round context"
  case "$team_mode" in
    suggest) MODE=suggest ;;
    review) [ "$MODE" != ship ] || MODE=review ;;
  esac
  [ "$MODE" != suggest ] || [ "${1:-}" = status ] || die 1 "team round mode is suggest: nothing to publish"
fi

# --- where we are ------------------------------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 1 "not inside a git worktree"
cd "$(git rev-parse --show-toplevel)" || die 1 "cannot enter the worktree"
branch="$(git symbolic-ref --quiet --short HEAD)" || die 1 "detached HEAD; check out your build branch"
[ "$branch" != "$DEFAULT_BRANCH" ] || die 1 "on $DEFAULT_BRANCH; shoemaker land publishes build branches only"
case "$branch" in "$BRANCH_PREFIX"*) ;; *) die 1 "$branch is not a ${BRANCH_PREFIX}* branch; land it by hand" ;; esac

if [ "$HOST" = none ]; then base="$DEFAULT_BRANCH"; else base="$REMOTE/$DEFAULT_BRANCH"; fi

has_ci() {
  case "$HOST" in
    github) git ls-tree -r --name-only "$base" -- .github/workflows 2>/dev/null | grep -Eq '\.ya?ml$' ;;
    gitlab) git cat-file -e "$base:.gitlab-ci.yml" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

# The gate this landing uses: merge-on-ci | merge-local | review.
gate() {
  [ "$MODE" = ship ] || { echo review; return; }
  case "$GATE" in
    ci) if has_ci; then echo merge-on-ci; else echo review; fi ;;
    local) echo merge-local ;;
    *) echo review ;;
  esac
}

verify_here() {
  say "local gate: ${SETUP_CMD:+$SETUP_CMD && }$VERIFY_CMD"
  if [ -n "${SETUP_CMD:-}" ]; then bash -c "$SETUP_CMD" || die 4 "SETUP_CMD failed; not merged"; fi
  bash -c "$VERIFY_CMD" || die 4 "VERIFY_CMD failed on the rebased commit; not merged"
}

# --- GitHub ---------------------------------------------------------------------------
gh_pr() { gh pr list --head "$branch" --state open --json number,url,isDraft --jq '.[0] // empty' 2>/dev/null; }

# gh_checks <pr>: prints "pass", "fail <names>", "pending" or "none"
gh_checks() {
  gh pr view "$1" --json statusCheckRollup --jq '
    [.statusCheckRollup[]? |
      if .__typename == "CheckRun" then
        {name: .name, s: (if .status != "COMPLETED" then "pending"
                          elif (.conclusion | IN("SUCCESS","NEUTRAL","SKIPPED")) then "pass" else "fail" end)}
      else
        {name: .context, s: (if .state == "SUCCESS" then "pass"
                             elif (.state | IN("PENDING","EXPECTED")) then "pending" else "fail" end)}
      end] as $c
    | if ($c | length) == 0 then "none"
      elif any($c[]; .s == "fail") then "fail " + ([$c[] | select(.s == "fail") | .name] | join(", "))
      elif any($c[]; .s == "pending") then "pending"
      else "pass" end'
}

gh_merge() {  # gh_merge <pr> <sha>
  gh pr merge "$1" --merge --match-head-commit "$2" --delete-branch >/dev/null 2>&1 \
    || die 3 "GitHub refused the merge of PR #$1 (branch protection, permissions, or the branch moved)"
  [ "$(gh pr view "$1" --json state --jq .state)" = MERGED ] || die 3 "PR #$1 did not merge"
  say "merged PR #$1 at ${2:0:12}: $(gh pr view "$1" --json url --jq .url)"
}

# --- GitLab ---------------------------------------------------------------------------
gl_mr() {
  local enc; enc="$(jq -rn --arg b "$branch" '$b|@uri')"
  glab api "projects/:id/merge_requests?state=opened&source_branch=$enc" 2>/dev/null | jq -c '.[0] // empty'
}

gl_merge() {  # gl_merge <iid> <sha> [when-pipeline-succeeds]
  local args=(-f "sha=$2" -f should_remove_source_branch=true)
  [ -n "${3:-}" ] && args+=(-f merge_when_pipeline_succeeds=true)
  glab api -X PUT "projects/:id/merge_requests/$1/merge" "${args[@]}" >/dev/null 2>&1
}

# --- open -------------------------------------------------------------------------------
cmd_open() {
  local title="" desc_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -t) title="${2:-}"; shift 2 ;;
      -F) desc_file="${2:-}"; shift 2 ;;
      *) die 1 "open: unknown argument $1" ;;
    esac
  done
  case "$MODE" in suggest|propose) die 1 "mode is $MODE: nothing to publish" ;; esac
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die 1 "uncommitted changes; commit them first"
  if [ "$HOST" != none ]; then
    timeout 60 git fetch -q "$REMOTE" "$DEFAULT_BRANCH" || die 3 "git fetch $REMOTE $DEFAULT_BRANCH failed"
  fi
  [ "$(git rev-list --count "$base..HEAD")" -gt 0 ] || die 1 "nothing on $branch beyond $base"

  if ! git rebase -q "$base" >/dev/null 2>&1; then
    local files; files="$(git diff --name-only --diff-filter=U | tr '\n' ' ')"
    git rebase --abort >/dev/null 2>&1
    die 1 "rebase on $base conflicts in: ${files:-?}. Rebase by hand, resolve, re-verify, then run shoemaker land open again."
  fi
  local sha g; sha="$(git rev-parse HEAD)"; g="$(gate)"
  [ "$g" = merge-local ] && verify_here
  [ -n "$title" ] || title="$(git log -1 --format=%s)"
  local desc; if [ -n "$desc_file" ]; then desc="$(cat "$desc_file")"; else desc="$(git log --reverse --format='- %s' "$base..HEAD")"; fi
  if [ "$MODE" = ship ] && [ "$g" = review ]; then
    say "NOTE: GATE=$GATE but there is nothing to gate a merge here (no CI in the repo, or no remote); opening for review instead"
  fi

  case "$HOST" in
    none)
      if [ "$g" != merge-local ]; then say "review: $branch is ready for the human (no remote)"; exit 0; fi
      local wt; wt="$(git worktree list --porcelain | awk -v b="refs/heads/$DEFAULT_BRANCH" '/^worktree /{p=substr($0,10)} $0=="branch " b {print p}')"
      git merge-base --is-ancestor "$DEFAULT_BRANCH" "$sha" || die 1 "$DEFAULT_BRANCH moved during the run; run shoemaker land open again"
      if [ -n "$wt" ]; then
        [ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ] \
          || die 1 "$DEFAULT_BRANCH is checked out at $wt with uncommitted changes; $branch is left for the human"
        git -C "$wt" merge -q --ff-only "$sha" || die 3 "fast-forward of $DEFAULT_BRANCH at $wt failed"
      else
        git update-ref "refs/heads/$DEFAULT_BRANCH" "$sha" "$(git rev-parse "$DEFAULT_BRANCH")" || die 3 "could not move $DEFAULT_BRANCH"
      fi
      say "merged: $DEFAULT_BRANCH fast-forwarded to ${sha:0:12}"; exit 0 ;;

    github)
      git push -q --force-with-lease -u "$REMOTE" HEAD 2>/dev/null || die 3 "git push of $branch failed"
      local pr n url; pr="$(gh_pr)"
      if [ -z "$pr" ]; then
        local args=(--base "$DEFAULT_BRANCH" --head "$branch" --title "$title" --body "$desc")
        [ "$g" = review ] && args+=(--draft)
        gh pr create "${args[@]}" >/dev/null 2>&1 || die 3 "gh pr create failed (gh auth status?)"
        pr="$(gh_pr)"; [ -n "$pr" ] || die 3 "the PR did not appear"
      fi
      n="$(jq -r .number <<<"$pr")"; url="$(jq -r .url <<<"$pr")"
      say "PR #$n: $url (pushed ${sha:0:12})"
      case "$g" in
        review) say "review: left for the human"; exit 0 ;;
        merge-local) gh_merge "$n" "$sha"; exit 0 ;;
        merge-on-ci) say "waiting for CI: run shoemaker land wait"; exit 5 ;;
      esac ;;

    gitlab)
      git push -q --force-with-lease -u "$REMOTE" HEAD 2>/dev/null || die 3 "git push of $branch failed"
      local mr iid url; mr="$(gl_mr)"
      if [ -z "$mr" ]; then
        local t="$title"; [ "$g" = review ] && t="Draft: $title"
        mr="$(glab api -X POST "projects/:id/merge_requests" -f "source_branch=$branch" -f "target_branch=$DEFAULT_BRANCH" \
              -f "title=$t" -f "description=$desc" -f remove_source_branch=true 2>/dev/null)" \
          || die 3 "creating the MR failed (glab auth status?)"
      fi
      iid="$(jq -r .iid <<<"$mr")"; url="$(jq -r .web_url <<<"$mr")"
      [ -n "$iid" ] && [ "$iid" != null ] || die 3 "the MR did not appear"
      say "MR !$iid: $url (pushed ${sha:0:12})"
      case "$g" in
        review) say "review: left for the human"; exit 0 ;;
        merge-local)
          gl_merge "$iid" "$sha" || die 3 "GitLab refused the merge of !$iid"
          [ "$(glab api "projects/:id/merge_requests/$iid" | jq -r .state)" = merged ] || die 3 "!$iid did not merge"
          say "merged !$iid at ${sha:0:12}"; exit 0 ;;
        merge-on-ci) say "waiting for CI: run shoemaker land wait"; exit 5 ;;
      esac ;;
    *) die 1 "HOST=$HOST is not github, gitlab or none" ;;
  esac
}

# --- wait -------------------------------------------------------------------------------
cmd_wait() {
  local secs="${1:-540}" end sha
  end=$(( $(date +%s) + secs )); sha="$(git rev-parse HEAD)"
  case "$HOST" in
    github)
      local pr n st c; pr="$(gh_pr)"
      if [ -z "$pr" ]; then
        [ "$(gh pr list --head "$branch" --state merged --json number --jq 'length' 2>/dev/null || echo 0)" -gt 0 ] 2>/dev/null && { say "already merged"; exit 0; }
        die 1 "no open PR for $branch; run shoemaker land open"
      fi
      n="$(jq -r .number <<<"$pr")"
      while :; do
        st="$(gh pr view "$n" --json state,headRefOid,mergeable --jq '[.state, .headRefOid, .mergeable] | @tsv' 2>/dev/null)" || st=""
        case "$st" in
          MERGED*) say "PR #$n merged"; exit 0 ;;
          CLOSED*) die 1 "PR #$n was closed" ;;
          "") ;;
          *) [ "$(cut -f2 <<<"$st")" = "$sha" ] || die 1 "PR #$n's head is not your commit ${sha:0:12} (someone pushed?)"
             [ "$(cut -f3 <<<"$st")" = CONFLICTING ] && die 1 "PR #$n conflicts with $DEFAULT_BRANCH; run shoemaker land open again to rebase"
             c="$(gh_checks "$n" 2>/dev/null || echo pending)"
             case "$c" in
               pass) [ "$(gate)" = merge-on-ci ] || { say "checks passed; review mode, left for the human"; exit 0; }
                     gh_merge "$n" "$sha"; exit 0 ;;
               fail*) die 4 "PR #$n: checks failed: ${c#fail }" ;;
             esac ;;
        esac
        if [ "$(date +%s)" -ge "$end" ]; then
          say "PR #$n: checks ${c:-unknown} after ${secs}s; run shoemaker land wait again"
          [ "${c:-}" = none ] && say "no checks reported yet: does the CI workflow run on pull_request?"
          exit 5
        fi
        sleep "$POLL"
      done ;;

    gitlab)
      local mr iid m st hs hp mwps
      mr="$(gl_mr)"
      if [ -z "$mr" ]; then
        local enc; enc="$(jq -rn --arg b "$branch" '$b|@uri')"
        [ "$(glab api "projects/:id/merge_requests?state=merged&source_branch=$enc" 2>/dev/null | jq 'length')" -gt 0 ] 2>/dev/null && { say "already merged"; exit 0; }
        die 1 "no open MR for $branch; run shoemaker land open"
      fi
      iid="$(jq -r .iid <<<"$mr")"
      while :; do
        m="$(glab api "projects/:id/merge_requests/$iid" 2>/dev/null)" || m=""
        if [ -n "$m" ]; then
          st="$(jq -r .state <<<"$m")"; hs="$(jq -r '.sha // ""' <<<"$m")"
          hp="$(jq -r 'if .head_pipeline and .head_pipeline.sha == .sha then .head_pipeline.status else "none" end' <<<"$m")"
          mwps="$(jq -r '.merge_when_pipeline_succeeds // false' <<<"$m")"
          case "$st" in merged) say "!$iid merged"; exit 0 ;; closed) die 1 "!$iid was closed" ;; esac
          [ "$hs" = "$sha" ] || die 1 "!$iid's head is not your commit ${sha:0:12} (someone pushed?)"
          [ "$(jq -r '.has_conflicts // false' <<<"$m")" = true ] && die 1 "!$iid conflicts with $DEFAULT_BRANCH; run shoemaker land open again to rebase"
          case "$hp" in
            success)
              [ "$(gate)" = merge-on-ci ] || { say "pipeline passed; review mode, left for the human"; exit 0; }
              gl_merge "$iid" "$sha" || true ;;
            failed|canceled|skipped) die 4 "!$iid: pipeline $hp: $(jq -r '.head_pipeline.web_url // ""' <<<"$m")" ;;
            none) ;;
            *) if [ "$mwps" != true ] && [ "$(gate)" = merge-on-ci ]; then
                 gl_merge "$iid" "$sha" when && say "!$iid: auto-merge set on ${sha:0:12} (pipeline $hp)"
               fi ;;
          esac
        fi
        [ "$(date +%s)" -lt "$end" ] || { say "!$iid: pipeline ${hp:-unknown} after ${secs}s; run shoemaker land wait again"; exit 5; }
        sleep "$POLL"
      done ;;

    none) say "no remote: nothing to wait for"; exit 0 ;;
    *) die 1 "HOST=$HOST is not github, gitlab or none" ;;
  esac
}

cmd_status() {
  case "$HOST" in
    github) local pr; pr="$(gh_pr)"; [ -n "$pr" ] && say "PR #$(jq -r .number <<<"$pr"): $(gh_checks "$(jq -r .number <<<"$pr")") $(jq -r .url <<<"$pr")" || say "no open PR for $branch" ;;
    gitlab) local mr; mr="$(gl_mr)"; [ -n "$mr" ] && say "MR !$(jq -r .iid <<<"$mr"): $(jq -r '.head_pipeline.status // "no pipeline"' <<<"$mr") $(jq -r .web_url <<<"$mr")" || say "no open MR for $branch" ;;
    none) say "$branch: $(git rev-list --count "$base..HEAD") commit(s) ahead of $base" ;;
  esac
}

case "${1:-}" in
  open) shift; cmd_open "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  status) cmd_status ;;
  *) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
