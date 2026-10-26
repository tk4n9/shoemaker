#!/usr/bin/env bash
# selftest.sh — exercise Shoemaker end to end in throwaway sandboxes, with stand-ins
# for claude, gh and glab. Nothing reaches a real host, no model is called, no timer
# is installed. Run it after changing bin/, harness/ or the queue.
#
#   test/selftest.sh          run every case; PASS/FAIL per check, exit 1 on any FAIL
#   test/selftest.sh --keep   keep the sandbox for inspection

set -uo pipefail
SM_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
keep=0; [ "${1:-}" = --keep ] && keep=1
T="$(mktemp -d "${TMPDIR:-/tmp}/shoemaker-selftest.XXXXXX")"
[ "$keep" = 1 ] && echo "sandbox: $T" || trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() {  # check "description" command...
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  PASS  $d"; else fail=$((fail + 1)); echo "  FAIL  $d"; fi
}
section() { echo; echo "== $*"; }
grep_q() { grep -q -- "$1" "$2"; }

[ -d "$SM_HOME/dashboard/node_modules/better-sqlite3" ] || { echo "selftest: run npm ci in dashboard/ first" >&2; exit 2; }
export GIT_AUTHOR_NAME=Selftest GIT_AUTHOR_EMAIL=selftest@example.invalid GIT_COMMITTER_NAME=Selftest GIT_COMMITTER_EMAIL=selftest@example.invalid
unset SHOEMAKER_STATE SHOEMAKER_MODE SHOEMAKER_AUTHOR CLAUDECODE
# Your own ~/.gitconfig and /etc/gitconfig stay out of it, and so does your systemd.
: >"$T/gitconfig"; export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
export HOME="$T/home"; mkdir -p "$HOME"

# --- stand-ins ----------------------------------------------------------------------------
STUBS="$T/stubs"; mkdir -p "$STUBS"
cat >"$STUBS/claude" <<'EOF'
#!/usr/bin/env bash
# Stand-in for `claude -p`: records how it was called, then acts out its role and SELFTEST_PLAN.
S="$SELFTEST_STATE"; printf '%s\n' "$*" >>"$S/claude-calls"
printf '%s\n' "$SHOEMAKER_AUTHOR" >>"$S/agent-starts"
env | grep -E '^SHOEMAKER_|^EXTRA_' | sort >"$S/claude-env-${SHOEMAKER_AUTHOR// /-}"
prompt="$*"
field() { sed -nE "s/.*$1[^\`]*\`([^\`]+)\`.*/\\1/p" <<<"$prompt" | head -n 1; }
ledger="$SHOEMAKER_STATE/LEDGER.md"
if [ -n "${SELFTEST_APPROVAL_PARALLEL:-}" ]; then
  touch "$S/approval-start-${SHOEMAKER_AUTHOR// /-}"
  for attempt in $(seq 1 250); do
    if [ "$(find "$S" -name 'approval-start-*' | wc -l)" -eq "$SELFTEST_APPROVAL_PARALLEL" ]; then
      touch "$S/approval-parallel-ok"; break
    fi
    sleep 0.02
  done
fi
result() { echo "{\"type\":\"result\",\"subtype\":\"success\",\"num_turns\":${1:-3},\"total_cost_usd\":0,\"is_error\":false,\"result\":\"done\"}"; }
if [ -n "${SHOEMAKER_TEAM_CONTEXT:-}" ] && jq -e '.auto_approval == true' "$SHOEMAKER_TEAM_CONTEXT" >/dev/null; then
  prompt="$(cat)"
  printf '%s\n' "$*" >>"$S/approve-calls"
  git commit -q --allow-empty -m "must refuse auto approver" >/dev/null 2>&1
  printf '%s\n' "$?" >"$S/approve-commit.rc"
  echo '{"reviews":[]}' >"$S/approve-forged.json"
  node "$SM_HOME/dashboard/bin/team.mjs" apply-result "$SHOEMAKER_TEAM_CONTEXT" "$S/approve-forged.json" >/dev/null 2>&1
  printf '%s\n' "$?" >"$S/approve-apply.rc"
  reviews="$(jq --arg verdict "${SELFTEST_APPROVAL_VERDICT:-approve}" '[.items[] | {id:.id,verdict:$verdict,body:"Fits the project and has a concrete spec."}]' "$SHOEMAKER_TEAM_CONTEXT")"
  if [ "${SELFTEST_APPROVAL_FLIP:-}" = off ]; then
    node --input-type=module -e "const { db } = await import('$SM_HOME/dashboard/src/db.js'); db.prepare('UPDATE config SET auto_approve = 0 WHERE id = 1').run();"
  fi
  echo '{"type":"system","subtype":"init","session_id":"sess-approve"}'
  jq -cn --argjson reviews "$reviews" '{type:"result",subtype:"success",num_turns:3,is_error:false,result:"Approval review complete.",structured_output:{reviews:$reviews}}'
  exit 0
fi
if [ -n "${SHOEMAKER_TEAM_CONTEXT:-}" ] && ! jq -e '.capabilities | index("build")' "$SHOEMAKER_TEAM_CONTEXT" >/dev/null; then
  prompt="$(cat)"
  agent_id="$(jq -r .agent_id "$SHOEMAKER_TEAM_CONTEXT")"
  if [[ "$agent_id" = ideas-* ]] && [ -n "${SELFTEST_TEAM_PARALLEL:-}" ]; then
    touch "$S/parallel-$agent_id"
    for attempt in $(seq 1 100); do
      if [ "$(find "$S" -name 'parallel-ideas-*' | wc -l)" -eq "$SELFTEST_TEAM_PARALLEL" ]; then touch "$S/parallel-ok"; break; fi
      sleep 0.02
    done
  fi
  printf '%s\n' "$agent_id" >>"$S/team-calls"
  git commit -q --allow-empty -m "must refuse non-build" >/dev/null 2>&1
  printf '%s\n' "$?" >"$S/team-commit-$agent_id.rc"
  echo '{"type":"system","subtype":"init","session_id":"sess-team"}'
  out='{}'
  if jq -e '.capabilities | index("propose")' "$SHOEMAKER_TEAM_CONTEXT" >/dev/null; then
    out="$(jq -n --arg agent "$agent_id" '{proposals:[{title:("Team idea " + $agent),body:("**Files:** `" + $agent + ".txt`"),priority:"normal"}]}')"
  fi
  if jq -e '.capabilities | index("review")' "$SHOEMAKER_TEAM_CONTEXT" >/dev/null; then
    verdict=approve
    if [ -n "${SELFTEST_TEAM_VERDICTS:-}" ]; then
      number="${agent_id##*-}"
      verdict="$(cut -d, -f"$number" <<<"$SELFTEST_TEAM_VERDICTS")"
    fi
    reviews="$(shoemaker queue list --status proposed --json | jq --arg a "$agent_id" --arg v "$verdict" '[.[] | {id:.id,verdict:$v,body:("Review by " + $a + ": " + $v)}]')"
    out="$(jq --argjson reviews "$reviews" '. + {reviews:$reviews}' <<<"$out")"
    case "$prompt" in *'Discussion turn'*)
      grep -q 'Review by' <<<"$prompt" && echo yes >"$S/discussion-$agent_id" ;;
    esac
  fi
  if jq -e '.capabilities | index("report")' "$SHOEMAKER_TEAM_CONTEXT" >/dev/null; then
    out="$(jq '. + {report:"# Report\nSynthetic analysis of the repository."}' <<<"$out")"
  fi
  jq -cn --argjson output "$out" '{type:"result",subtype:"success",num_turns:3,is_error:false,result:"done",structured_output:$output}'
  exit 0
fi
[ "${SELFTEST_PLAN:-}" = nostart ] && { echo '{"type":"result","subtype":"error","num_turns":0,"is_error":true,"result":"usage limit reached"}'; exit 1; }
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
case "$SHOEMAKER_AUTHOR" in
  "suggestion agent")
    rd="$(field 'run directory, for your idea files')"
    git commit -q --allow-empty -m "should be refused" >/dev/null 2>&1; echo "$?" >"$S/suggest-commit.rc"
    for i in $(seq 1 "${SELFTEST_IDEAS:-1}"); do
      printf '**Files:** `%s`\n' "${SELFTEST_FILE:-CHANGES.md}" >"$rd/idea-$i.md"
      shoemaker queue add --title "Idea $i from $SHOEMAKER_RUN_ID" --body-file "$rd/idea-$i.md" --priority normal --run "$SHOEMAKER_RUN_ID" >/dev/null
    done
    echo "suggested" >"$rd/summary.md" ;;
  "implementation agent")
    B="$(sed -nE 's/.*# Shoemaker round ([^:]+): implementation agent.*/\1/p' <<<"$prompt" | head -n 1)"
    id="$(sed -nE 's/.*your item: \*\*#([0-9]+) .*/\1/p' <<<"$prompt" | head -n 1)"
    case " $* " in
      *" --resume sess-1 "*)
        # The resume prompt names the ledger heading to write: '### <run id> — <outcome> — #<item> <title>'.
        B="$(sed -nE "s/.*'### ([^ ]+) — <outcome> — #([0-9]+).*/\1/p" <<<"$prompt" | head -n 1)"
        id="$(sed -nE "s/.*'### ([^ ]+) — <outcome> — #([0-9]+).*/\2/p" <<<"$prompt" | head -n 1)"
        shoemaker queue ship "$id" --note "selftest resume" >/dev/null
        printf '\n### %s — merged — #%s resumed and recorded\n- notes: selftest resume\n' "$B" "$id" >>"$ledger" ;;
      *) case "${SELFTEST_PLAN:-}" in
           work)
             git branch -m "$(git branch --show-current | sed -E 's/-[0-9-]+(-r[0-9]+)?$//')-demo"
             echo "change $id" >>"CHANGES-$id.md" && git add "CHANGES-$id.md" && git commit -qm "feat: selftest change $id"
             shoemaker queue set "$id" --branch "$(git branch --show-current)" >/dev/null
             # As the protocol says: when the default branch moved under it (exit 1) or a
             # git step lost a race with a build alongside (exit 3), land again.
             for try in 1 2 3; do
               shoemaker land open -t "feat: selftest change $id" >>"$S/land-open-$id.out" 2>&1; rc=$?
               case "$rc" in 1|3) sleep "$try" ;; *) break ;; esac
             done
             echo "$rc" >"$S/land-open-$id.rc"
             if [ "$rc" = 0 ] && [ "$SHOEMAKER_MODE" = ship ]; then shoemaker queue ship "$id" >/dev/null; out=merged
             else shoemaker queue review "$id" >/dev/null; out=review-open; fi
             printf '\n### %s — %s — #%s selftest change\n- notes: selftest\n' "$B" "$out" "$id" >>"$ledger" ;;
           skip-ledger) ;;
         esac ;;
    esac ;;
esac
result 3
EOF

cat >"$STUBS/gh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for the GitHub CLI over one PR kept in $SELFTEST_STATE/pr.json.
S="$SELFTEST_STATE"; echo "gh $*" >>"$S/gh-calls"
jqx=""; a=()
while [ $# -gt 0 ]; do case "$1" in --jq) jqx="$2"; shift 2 ;; --json) shift 2 ;; *) a+=("$1"); shift ;; esac; done
set -- "${a[@]}"
out() { if [ -n "$jqx" ]; then jq -r "$jqx"; else cat; fi; }
remote_head() { git --git-dir="$SELFTEST_BARE" rev-parse "refs/heads/$1" 2>/dev/null; }
case "$1 ${2:-}" in
  "repo view") echo '{"name":"app","nameWithOwner":"demo/app","viewerPermission":"ADMIN"}' | out ;;
  "api -i") printf 'HTTP/2 200\r\ngithub-authentication-token-expiration: %s\r\n\r\n{"login":"tester"}\n' "$(cat "$S/token-exp" 2>/dev/null || echo '2099-01-01 00:00:00 UTC')" ;;
  "api user") echo '{"login":"tester"}' | out ;;
  "pr list")
    shift 2; head=""; st=""
    while [ $# -gt 0 ]; do case "$1" in --head) head="$2"; shift 2 ;; --state) st="$2"; shift 2 ;; *) shift ;; esac; done
    if [ -f "$S/pr.json" ] && [ "$(jq -r .headRefName "$S/pr.json")" = "$head" ] && [ "$(jq -r '.state|ascii_downcase' "$S/pr.json")" = "$st" ]; then jq -c '[.]' "$S/pr.json"; else echo '[]'; fi | out ;;
  "pr create")
    shift 2; head=""; draft=false; title=""
    while [ $# -gt 0 ]; do case "$1" in --head) head="$2"; shift 2 ;; --title) title="$2"; shift 2 ;; --draft) draft=true; shift ;; *) shift ;; esac; done
    jq -n --arg h "$head" --arg t "$title" --argjson d "$draft" '{number:7,url:"https://github.com/demo/app/pull/7",headRefName:$h,isDraft:$d,state:"OPEN",title:$t}' >"$S/pr.json"
    echo "https://github.com/demo/app/pull/7" ;;
  "pr view")
    [ -f "$S/pr.json" ] || { echo "no pull requests found" >&2; exit 1; }
    h="$(jq -r .headRefName "$S/pr.json")"; c="$(cat "$S/checks" 2>/dev/null || echo none)"
    jq --arg sha "$(remote_head "$h")" --arg c "$c" '. + {headRefOid:$sha, mergeable:"MERGEABLE", statusCheckRollup:
        (if $c == "none" then [] elif $c == "pending" then [{__typename:"CheckRun",name:"ci",status:"IN_PROGRESS",conclusion:null}]
         elif $c == "pass" then [{__typename:"CheckRun",name:"ci",status:"COMPLETED",conclusion:"SUCCESS"},{__typename:"StatusContext",context:"lint",state:"SUCCESS"}]
         else [{__typename:"CheckRun",name:"ci",status:"COMPLETED",conclusion:"FAILURE"}] end)}' "$S/pr.json" | out ;;
  "pr merge")
    shift 2; sha=""; while [ $# -gt 0 ]; do case "$1" in --match-head-commit) sha="$2"; shift 2 ;; *) shift ;; esac; done
    h="$(jq -r .headRefName "$S/pr.json")"
    [ "$sha" = "$(remote_head "$h")" ] || { echo "head moved" >&2; exit 1; }
    jq '.state = "MERGED"' "$S/pr.json" >"$S/pr.tmp" && mv "$S/pr.tmp" "$S/pr.json"; echo "$sha" >"$S/merged-sha" ;;
  "run rerun") ;;
  *) echo "gh stub: unhandled: $*" >&2; exit 1 ;;
esac
EOF

cat >"$STUBS/glab" <<'EOF'
#!/usr/bin/env bash
# Stand-in for `glab api` over one MR kept in $SELFTEST_STATE/mr.json.
S="$SELFTEST_STATE"; echo "glab $*" >>"$S/glab-calls"
[ "${1:-}" = api ] || { echo "glab stub: only api" >&2; exit 1; }; shift
m=GET; ep=""; declare -A F=()
while [ $# -gt 0 ]; do case "$1" in -X) m="$2"; shift 2 ;; -f|-F) F["${2%%=*}"]="${2#*=}"; shift 2 ;; *) ep="$1"; shift ;; esac; done
remote_head() { git --git-dir="$SELFTEST_BARE" rev-parse "refs/heads/$1" 2>/dev/null; }
live() {  # the MR as GitLab would show it now
  local src p; src="$(jq -r .source_branch "$S/mr.json")"; p="$(cat "$S/pipeline" 2>/dev/null || echo none)"
  # GitLab merges an auto-merge MR when its pipeline passes.
  if [ "$p" = success ] && [ "$(jq -r .merge_when_pipeline_succeeds "$S/mr.json")" = true ]; then
    jq '.state = "merged"' "$S/mr.json" >"$S/mr.tmp" && mv "$S/mr.tmp" "$S/mr.json"
  fi
  jq --arg sha "$(remote_head "$src")" --arg p "$p" '. + {sha:$sha, has_conflicts:false,
      head_pipeline: (if $p == "none" then null else {sha:$sha, status:$p, web_url:"https://gitlab.example/p/1"} end)}' "$S/mr.json"
}
case "$m $ep" in
  "GET user") echo '{"username":"tester"}' ;;
  "GET personal_access_tokens/self") echo "{\"name\":\"t\",\"scopes\":[\"api\"],\"expires_at\":\"$(cat "$S/token-exp" 2>/dev/null || echo 2099-01-01)\"}" ;;
  "GET projects/:id/merge_requests?"*)
    st="$(sed -E 's/.*state=([a-z]+).*/\1/' <<<"$ep")"; src="$(sed -E 's/.*source_branch=([^&]+).*/\1/' <<<"$ep" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')"
    if [ -f "$S/mr.json" ] && [ "$(live | jq -r .state)" = "$st" ] && [ "$(jq -r .source_branch "$S/mr.json")" = "$src" ]; then live | jq -c '[.]'; else echo '[]'; fi ;;
  "POST projects/:id/merge_requests")
    jq -n --arg s "${F[source_branch]}" --arg t "${F[title]}" '{iid:3, web_url:"https://gitlab.example/demo/app/-/merge_requests/3", source_branch:$s, title:$t, state:"opened", merge_when_pipeline_succeeds:false}' >"$S/mr.json"
    live ;;
  "GET projects/:id/merge_requests/3") live ;;
  "PUT projects/:id/merge_requests/3/merge")
    [ "${F[sha]:-}" = "$(live | jq -r .sha)" ] || { echo '{"message":"SHA does not match HEAD"}'; exit 1; }
    if [ "${F[merge_when_pipeline_succeeds]:-}" = true ]; then
      jq '.merge_when_pipeline_succeeds = true' "$S/mr.json" >"$S/mr.tmp" && mv "$S/mr.tmp" "$S/mr.json"
    else
      p="$(cat "$S/pipeline" 2>/dev/null || echo none)"
      case "$p" in success|none) jq '.state = "merged"' "$S/mr.json" >"$S/mr.tmp" && mv "$S/mr.tmp" "$S/mr.json"; echo "${F[sha]}" >"$S/merged-sha" ;;
        *) echo '{"message":"405 Method Not Allowed"}'; exit 1 ;; esac
    fi
    live ;;
  *) echo "glab stub: unhandled: $m $ep" >&2; exit 1 ;;
esac
EOF
chmod +x "$STUBS"/*
export PATH="$STUBS:$SM_HOME/bin:$PATH"
SM="$SM_HOME/bin/shoemaker"

# new_project NAME [remote-url]: a repo with one commit on main and a passing test
new_project() {
  local d="$T/$1"; mkdir -p "$d"; git init -q -b main "$d/repo"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$d/repo/test.sh"; chmod +x "$d/repo/test.sh"
  git -C "$d/repo" add test.sh && git -C "$d/repo" commit -qm "init"
  git -C "$d/repo" config user.name Selftest; git -C "$d/repo" config user.email selftest@example.invalid
  if [ -n "${2:-}" ]; then
    git init -q --bare -b main "$d/remote.git"
    git -C "$d/repo" remote add origin "$2"
    git -C "$d/repo" config "url.$d/remote.git.insteadOf" "$2"
    git -C "$d/repo" push -q -u origin main
    git -C "$d/repo" remote set-head origin main >/dev/null 2>&1
  fi
  echo "$d"
}
# setup DIR HOST GATE: shoemaker init + schedule for DIR/repo at DIR/state, mode ship
setup() {
  "$SM" init "$1/state" PROJECT="$(basename "$1")" REPO="$1/repo" HOST="$2" DEFAULT_BRANCH=main GATE="$3" \
    VERIFY_CMD="./test.sh" >/dev/null &&
  "$SM" -s "$1/state" schedule "*-*-* 03:30:00" --timezone Asia/Seoul >/dev/null &&
  sed -i -E 's/^mode: [a-z]+/mode: ship/' "$1/state/DIRECTION.md"
}
front() { sed -i -E "s/^$2:[^#]*/$2: $3   /" "$1/DIRECTION.md"; }
# approve STATE ID [priority 0-3]: what the human does on the dashboard
approve() {
  SHOEMAKER_STATE="$1" node --input-type=module -e "
    const { db, initSchema } = await import('$SM_HOME/dashboard/src/db.js');
    const Q = await import('$SM_HOME/dashboard/src/queue.js');
    initSchema(); Q.approve(db, $2, ${3:-2});"
}
status_of() { SHOEMAKER_STATE="$1" "$SM" queue show "$2" --json | jq -r .status; }
auto_approve() {  # dashboard setting, changed by a human stand-in
  SHOEMAKER_STATE="$1" node --input-type=module -e "
    const { db, initSchema } = await import('$SM_HOME/dashboard/src/db.js');
    initSchema(); db.prepare('UPDATE config SET auto_approve = ? WHERE id = 1').run($2);"
}
direction_setting() {
  if grep -q "^$2:" "$1/DIRECTION.md"; then front "$1" "$2" "$3"
  else sed -i "1a\\$2: $3" "$1/DIRECTION.md"; fi
}
export SM SM_HOME; export -f status_of approve front

# === 1. setup ===================================================================================
section "setup: init, schedule, doctor"
P="$(new_project local)"; export SELFTEST_STATE="$P/selftest"; mkdir -p "$SELFTEST_STATE"
check "init + schedule" setup "$P" none local
N="$P/state"
check "init wrote the human files and the queue" bash -c "cd '$N' && test -f shoemaker.conf -a -f DIRECTION.md -a -f RULES.md -a -f LEDGER.md -a -f README.md -a -f queue.db"
check "dashboard.json is private and has a password" bash -c "[ \"\$(stat -c %a '$N/dashboard.json')\" = 600 ] && jq -e '.password | length >= 16' '$N/dashboard.json'"
check "init refuses to overwrite" bash -c "! '$SM' init '$N' PROJECT=x REPO='$P/repo' HOST=none DEFAULT_BRANCH=main GATE=none"
check "init refuses a bad HOST" bash -c "! '$SM' init '$T/bad' PROJECT=x REPO='$P/repo' HOST=bitbucket DEFAULT_BRANCH=main GATE=none"
check "units rendered with the timezone" grep_q "OnCalendar=\*-\*-\* 03:30:00 Asia/Seoul" "$N/systemd/shoemaker-local.timer"
check "units point at this checkout and state" grep_q "$SM_HOME/bin/shoemaker\" --state \"$N\" run" "$N/systemd/shoemaker-local.service"
check "the dashboard unit exists" test -f "$N/systemd/shoemaker-local-dashboard.service"
check "the state is found from inside it" bash -c "cd '$N/runs' && '$SM' status | grep -q '^local '"
check "doctor passes, with the guard in place" bash -c "cd '$N' && '$SM' doctor | grep -q 'publish guard: in place'"
check "doctor leaves no worktree behind" test -z "$(ls "$N/worktrees")"
check "status runs" bash -c "'$SM' -s '$N' status | grep -q 'queue:'"
sed -i -E 's/^enabled: true/enabled: false/' "$N/DIRECTION.md"
check "enabled: false exits without running" bash -c "'$SM' -s '$N' run | grep -q 'enabled: false'"
sed -i -E 's/^enabled: false/enabled: true/' "$N/DIRECTION.md"

# === 2. a round: suggest, approve, build ===========================================================
section "rounds: suggest, approve, build (local gate)"
"$SM" -s "$N" run >/dev/null 2>&1
check "the suggestion agent added an idea" bash -c "[ \"\$(SHOEMAKER_STATE='$N' '$SM' queue stats --json | jq .proposed)\" = 1 ]"
check "...from its own read-only checkout: its commit was refused" grep_q '^1$' "$SELFTEST_STATE/suggest-commit.rc"
check "...and wrote summary.md" bash -c "ls '$N'/runs/*/suggest/summary.md"
check "nothing was built without approval" bash -c "[ ! -s '$SELFTEST_STATE/claude-env-implementation-agent' ] && [ \"\$(status_of '$N' 1)\" = proposed ]"
check "the agents got the guard settings" grep_q "--settings $N/guard/claude-settings.json" "$SELFTEST_STATE/claude-calls"
front "$N" max_waiting 1
: >"$SELFTEST_STATE/claude-calls"
"$SM" -s "$N" run >/dev/null 2>&1
check "a full review list starts no agent; the round leaves one idle line" bash -c "[ ! -s '$SELFTEST_STATE/claude-calls' ] && grep -q 'not this round' '$N/runs/idle.log'"
front "$N" max_waiting 0
approve "$N" 1
SELFTEST_PLAN=work "$SM" -s "$N" run >/dev/null 2>&1
check "the approved item was built and landed (exit 0)" grep_q '^0$' "$SELFTEST_STATE/land-open-1.rc"
check "SHOEMAKER_MODE=ship reached the agent" grep_q "SHOEMAKER_MODE=ship" "$SELFTEST_STATE/claude-env-implementation-agent"
check "main now has the change" bash -c "git -C '$P/repo' log --oneline main | grep -q 'selftest change 1'"
check "the item is shipped" bash -c "[ \"\$(status_of '$N' 1)\" = shipped ]"
check "the ledger has the build's entry" bash -c "grep -qE '^### [0-9-]+(-r[0-9]+)?-q1 — merged' '$N/LEDGER.md'"
check "the merged worktree was removed" bash -c "! ls '$N/worktrees' | grep -q q1"

section "rounds: resume, give back, crash"
SHOEMAKER_STATE="$N" "$SM" queue add --title "second" >/dev/null; approve "$N" 2
: >"$SELFTEST_STATE/claude-calls"
SELFTEST_PLAN=skip-ledger "$SM" -s "$N" run >/dev/null 2>&1
check "an unrecorded build is resumed once" grep_q "--resume sess-1" "$SELFTEST_STATE/claude-calls"
check "the resumed session recorded the build" grep_q "#2 resumed and recorded" "$N/LEDGER.md"
SHOEMAKER_STATE="$N" "$SM" queue add --title "third" >/dev/null; approve "$N" 3
SELFTEST_PLAN=nostart "$SM" -s "$N" run >/dev/null 2>&1
check "an agent that never started gives its attempt back" bash -c "SHOEMAKER_STATE='$N' '$SM' queue show 3 --json | jq -e '.attempts == 0 and .status == \"approved\"'"
check "...and no crash is recorded" bash -c "! grep -q 'q3 — crashed' '$N/LEDGER.md'"
SELFTEST_PLAN=skip-ledger SHOEMAKER_TIMEOUT=200s "$SM" -s "$N" run >/dev/null 2>&1
check "a build that leaves no record (and no time to resume) is recorded as crashed" grep_q "q3 — crashed" "$N/LEDGER.md"
check "...and stays in progress for the next round" bash -c "[ \"\$(status_of '$N' 3)\" = in_progress ]"

section "rounds: side by side, never two on one file"
P2="$(new_project para)"; export SELFTEST_STATE="$P2/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$P2" none local; N2="$P2/state"; front "$N2" max_builds 3; front "$N2" max_waiting 0
for t in a b c; do printf '**Files:** `%s.txt`\n' "$([ $t = c ] && echo a || echo $t)" | SHOEMAKER_STATE="$N2" "$SM" queue add --title "$t" --body-file - >/dev/null; done
for i in 1 2 3; do approve "$N2" "$i"; done
SELFTEST_PLAN=work "$SM" -s "$N2" run >/dev/null 2>&1
check "two items built side by side" bash -c "[ \"\$(status_of '$N2' 1)\" = shipped ] && [ \"\$(status_of '$N2' 2)\" = shipped ]"
check "the one sharing a file waited" bash -c "[ \"\$(status_of '$N2' 3)\" = approved ]"
check "both changes are on main" bash -c "git -C '$P2/repo' log --oneline main | grep -q 'change 1' && git -C '$P2/repo' log --oneline main | grep -q 'change 2'"

section "rounds: preflight falls back to suggestions"
export SELFTEST_STATE="$P/selftest"
git -C "$P/repo" config --unset user.email; git -C "$P/repo" config --unset user.name
check "no Git identity: no implementation this round" bash -c "env -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_EMAIL '$SM' -s '$N' doctor | grep -q 'no Git identity'"
git -C "$P/repo" config user.name Selftest; git -C "$P/repo" config user.email selftest@example.invalid
sed -i -E 's/^GUARD=1/GUARD=0/' "$N/shoemaker.conf"
check "GUARD=0: doctor says the guard is off" bash -c "'$SM' -s '$N' doctor | grep -q 'publish guard: off'"
sed -i -E 's/^GUARD=0/GUARD=1/' "$N/shoemaker.conf"

# === 3. the guard ===============================================================================
section "guard: the Claude hook"
G="$SM_HOME/harness/guard/claude-guard.sh"
blocked() { local rc; printf '%s' "$1" | "$G" "$N" >/dev/null 2>&1; rc=$?; [ "$rc" = 2 ]; }
allowed() { printf '%s' "$1" | "$G" "$N" >/dev/null 2>&1; }
bash_json() { jq -cn --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }
edit_json() { jq -cn --arg p "$1" '{tool_name:"Edit",tool_input:{file_path:$p}}'; }
for c in "git push origin main" "git push origin HEAD:main" "git push --force origin +main" "git push --all" \
         "git commit --no-verify -m x" "git commit -anm x" "git config core.hooksPath /tmp" "git config --worktree shoemaker.role build" \
         "gh pr merge 7 --merge" "glab mr merge 3" "glab api -X PUT projects/:id/merge_requests/3/merge" "gh auth token" \
         "cat ~/.ssh/id_rsa" "cat $N/dashboard.json" "sqlite3 $N/queue.db 'update todos set status=1'" \
         "sudo rm -rf /tmp/x" "git branch -f main HEAD" "sed -i s/a/b/ $N/RULES.md" "echo x > $N/DIRECTION.md" \
         "echo x >> $SM_HOME/harness/IMPLEMENT.md"; do
  check "blocks: $c" blocked "$(bash_json "$c")"
done
for c in "git push -u origin HEAD" "git push --force-with-lease -u origin shoemaker/q1-x" "git status" "npm test" \
         "shoemaker land open -t x" "shoemaker queue note 1 hi" "cat $N/RULES.md" "cat $SM_HOME/harness/IMPLEMENT.md" \
         "git commit -m 'note -n flag'" "cat >> $N/LEDGER.md <<'X'"; do
  check "allows: $c" allowed "$(bash_json "$c")"
done
check "blocks: Edit of DIRECTION.md" blocked "$(edit_json "$N/DIRECTION.md")"
check "blocks: Edit of RULES.md" blocked "$(edit_json "$N/RULES.md")"
check "blocks: Edit of shoemaker.conf" blocked "$(edit_json "$N/shoemaker.conf")"
check "blocks: Edit of the active team" blocked "$(edit_json "$N/team/active.json")"
check "blocks: Edit of an authoritative team context" blocked "$(edit_json "$N/team/runtime/round/stage/role/1.json")"
check "blocks: changing a worktree team context" blocked "$(bash_json "git config --worktree shoemaker.teamContext /tmp/other.json")"
check "blocks: Edit of the installation" blocked "$(edit_json "$SM_HOME/harness/run.sh")"
check "allows: Edit of LEDGER.md" allowed "$(edit_json "$N/LEDGER.md")"
check "allows: Write in runs/" allowed "$(edit_json "$N/runs/x/summary.md")"
check "allows: Edit in an agent worktree" allowed "$(edit_json "$N/worktrees/2026-01-01-0330-q1/src/a.js")"
check "allows: Edit in the repository" allowed "$(edit_json "$P/repo/src/a.js")"
check "blocks: Edit of a worktree's .git link" blocked "$(edit_json "$N/worktrees/2026-01-01-0330-q1/.git")"
check "blocks: DIRECTION.md through runs/.." blocked "$(edit_json "$N/runs/../DIRECTION.md")"
check "blocks: without a state directory" bash -c "printf '%s' '$(bash_json "git status")' | '$G' '$T/nowhere'; [ \$? = 2 ]"

section "guard: the worktree git hooks"
Q="$(new_project hooks "git@example.invalid:demo/hooks.git")"
mkdir -p "$Q/repo/.githooks"; printf '#!/usr/bin/env bash\ntouch "%s/own-hook-ran"\n' "$Q" >"$Q/repo/.githooks/pre-commit"; chmod +x "$Q/repo/.githooks/pre-commit"
git -C "$Q/repo" add .githooks && git -C "$Q/repo" commit -qm "own hooks"
git -C "$Q/repo" config core.hooksPath .githooks; rm -f "$Q/own-hook-ran"
"$SM" init "$Q/state" PROJECT=hooks REPO="$Q/repo" HOST=none DEFAULT_BRANCH=main GATE=none VERIFY_CMD=./test.sh >/dev/null
git -C "$Q/repo" config extensions.worktreeConfig true
git -C "$Q/repo" switch -q -c dev
git -C "$Q/repo" worktree add -q "$Q/wt" main
git -C "$Q/wt" config --worktree core.hooksPath "$SM_HOME/harness/guard/git-hooks"
git -C "$Q/wt" config --worktree shoemaker.state "$Q/state"; git -C "$Q/wt" config --worktree shoemaker.role build
check "refuses a commit on main in an agent worktree" bash -c "cd '$Q/wt' && echo a >a && git add a && ! git commit -qm a"
git -C "$Q/wt" switch -q -c shoemaker/q1-x
check "allows a commit on a build branch" bash -c "cd '$Q/wt' && git commit -qm a"
check "...and ran the repo's own pre-commit hook" test -f "$Q/own-hook-ran"
check "refuses a push to main" bash -c "cd '$Q/wt' && ! git push -q origin HEAD:main 2>/dev/null"
check "allows a push of the build branch" bash -c "cd '$Q/wt' && git push -q origin HEAD:shoemaker/q1-x"
git -C "$Q/wt" config --worktree shoemaker.role suggest
check "refuses any commit by the suggestion agent" bash -c "cd '$Q/wt' && ! git commit -q --allow-empty -m b"
check "refuses any push by the suggestion agent" bash -c "cd '$Q/wt' && ! git push -q origin HEAD:shoemaker/q1-y 2>/dev/null"
git -C "$Q/wt" config --worktree --unset shoemaker.state
check "refuses when the worktree has no Shoemaker state" bash -c "cd '$Q/wt' && ! git commit -q --allow-empty -m c"
check "the main checkout keeps its own hooks" bash -c "[ \"\$(git -C '$Q/repo' config core.hooksPath)\" = .githooks ]"

# === 4. GitHub =====================================================================================
gh_case() {  # gh_case NAME: a GitHub-like project with CI, and a worktree on a build branch
  P="$(new_project "$1" "git@github.com:demo/$1.git")"; export SELFTEST_STATE="$P/selftest" SELFTEST_BARE="$P/remote.git"; mkdir -p "$SELFTEST_STATE"
  mkdir -p "$P/repo/.github/workflows"; echo "on: pull_request" >"$P/repo/.github/workflows/ci.yml"
  git -C "$P/repo" add .github && git -C "$P/repo" commit -qm ci && git -C "$P/repo" push -q origin main
  setup "$P" github ci; N="$P/state"
  git -C "$P/repo" worktree add -q -b shoemaker/q1-demo "$N/worktrees/w1" origin/main
  git -C "$N/worktrees/w1" config shoemaker.state "$N"
  (cd "$N/worktrees/w1" && echo x >x && git add x && git commit -qm "feat: x")
}
land() { (cd "$W" && SHOEMAKER_MODE="$1" SHOEMAKER_LAND_POLL=1 "$SM" land "${@:2}"); }
section "GitHub: ship with CI"
gh_case ghship; W="$N/worktrees/w1"
check "doctor passes with gh logged in" "$SM" -s "$N" doctor
echo pending >"$SELFTEST_STATE/checks"
land ship open -t "feat: x" >/dev/null 2>&1; rc=$?
check "open: PR created, waiting for CI (exit 5)" test "$rc" = 5
check "the PR is not a draft" bash -c "jq -e '.isDraft == false' '$SELFTEST_STATE/pr.json'"
land ship wait 2 >/dev/null 2>&1; rc=$?
check "wait while CI runs: exit 5, not merged" bash -c "[ $rc = 5 ] && [ ! -f '$SELFTEST_STATE/merged-sha' ]"
check "never used gh pr merge --auto" bash -c "! grep -q -- '--auto' '$SELFTEST_STATE/gh-calls'"
echo pass >"$SELFTEST_STATE/checks"
land ship wait 5 >/dev/null 2>&1; rc=$?
check "wait after CI passed: merged (exit 0)" test "$rc" = 0
check "merged pinned to the pushed commit" bash -c "[ \"\$(cat '$SELFTEST_STATE/merged-sha')\" = \"\$(git -C '$W' rev-parse HEAD)\" ]"

section "GitHub: the runner reconciles merged PRs"
SHOEMAKER_STATE="$N" "$SM" queue add --title "reconcile me" >/dev/null; approve "$N" 1
SHOEMAKER_STATE="$N" SHOEMAKER_AUTHOR=runner "$SM" queue claim 1 --run r1 >/dev/null
SHOEMAKER_STATE="$N" "$SM" queue review 1 --pr https://github.com/demo/app/pull/7 >/dev/null
front "$N" max_waiting 0
"$SM" -s "$N" run >/dev/null 2>&1
check "an item whose PR merged is marked shipped at the next round" bash -c "[ \"\$(status_of '$N' 1)\" = shipped ]"

section "GitHub: CI fails"
gh_case ghfail; W="$N/worktrees/w1"; echo fail >"$SELFTEST_STATE/checks"
land ship open -t "feat: x" >/dev/null 2>&1
land ship wait 3 >/dev/null 2>&1; rc=$?
check "red CI: exit 4, not merged" bash -c "[ $rc = 4 ] && [ ! -f '$SELFTEST_STATE/merged-sha' ]"

section "GitHub: review mode, and ship without CI"
gh_case ghreview; W="$N/worktrees/w1"; echo pass >"$SELFTEST_STATE/checks"
land review open -t "feat: x" >/dev/null 2>&1; rc=$?
check "review: a draft PR, exit 0, not merged" bash -c "[ $rc = 0 ] && jq -e '.isDraft' '$SELFTEST_STATE/pr.json' && [ ! -f '$SELFTEST_STATE/merged-sha' ]"
gh_case ghnoci; W="$N/worktrees/w1"
git -C "$P/repo" rm -q -r .github && git -C "$P/repo" commit -qm "no ci" && git -C "$P/repo" push -q origin main
land ship open -t "feat: x" >"$SELFTEST_STATE/out" 2>&1; rc=$?
check "ship without CI lands as a draft for review" bash -c "[ $rc = 0 ] && jq -e '.isDraft' '$SELFTEST_STATE/pr.json' && grep -q 'opening for review' '$SELFTEST_STATE/out'"
check "the runner says so up front" bash -c "'$SM' -s '$N' doctor | grep -q 'no CI to gate merges'"

section "GitHub: preflight"
echo "$(date -u -d '+5 days' '+%F %T') UTC" >"$SELFTEST_STATE/token-exp"
check "warns about a token expiring in 5 days" bash -c "'$SM' -s '$N' doctor | grep -q 'token expires'"
check "a rebase conflict is refused with the file named" bash -c "
  cd '$P/repo' && echo main-side >x && git add x && git commit -qm 'main x' && git push -q origin main &&
  cd '$W' && echo build-side >x && git commit -qam 'build x' &&
  SHOEMAKER_MODE=ship '$SM' land open 2>&1 | grep -q 'conflicts in: x'"
check "and leaves the branch as it was (no rebase in progress)" bash -c "cd '$W' && [ ! -d \"\$(git rev-parse --git-path rebase-merge)\" ]"

# === 5. GitLab =====================================================================================
section "GitLab: ship with CI"
P="$(new_project glship "git@gitlab.example:demo/glship.git")"; export SELFTEST_STATE="$P/selftest" SELFTEST_BARE="$P/remote.git"; mkdir -p "$SELFTEST_STATE"
echo "test: {script: [./test.sh]}" >"$P/repo/.gitlab-ci.yml"; git -C "$P/repo" add .gitlab-ci.yml && git -C "$P/repo" commit -qm ci && git -C "$P/repo" push -q origin main
setup "$P" gitlab ci; N="$P/state"
git -C "$P/repo" worktree add -q -b shoemaker/q1-demo "$N/worktrees/w1" origin/main; W="$N/worktrees/w1"
git -C "$W" config shoemaker.state "$N"
(cd "$W" && echo x >x && git add x && git commit -qm "feat: x")
check "doctor passes with glab logged in" "$SM" -s "$N" doctor
echo running >"$SELFTEST_STATE/pipeline"
land ship open -t "feat: x" >/dev/null 2>&1; rc=$?
check "open: MR created, waiting (exit 5)" test "$rc" = 5
land ship wait 2 >/dev/null 2>&1; rc=$?
check "wait while the pipeline runs: auto-merge set, pinned, exit 5" bash -c "[ $rc = 5 ] && jq -e '.merge_when_pipeline_succeeds' '$SELFTEST_STATE/mr.json' && grep -q 'sha=' '$SELFTEST_STATE/glab-calls'"
echo success >"$SELFTEST_STATE/pipeline"
land ship wait 5 >/dev/null 2>&1; rc=$?
check "pipeline passed: merged (exit 0)" test "$rc" = 0
section "GitLab: pipeline fails"
rm -f "$SELFTEST_STATE/mr.json"; echo failed >"$SELFTEST_STATE/pipeline"
git -C "$P/repo" worktree add -q -b shoemaker/q2-demo "$N/worktrees/w2" origin/main; W="$N/worktrees/w2"
git -C "$W" config shoemaker.state "$N"
(cd "$W" && echo y >y && git add y && git commit -qm "feat: y") && land ship open -t "feat: y" >/dev/null 2>&1
land ship wait 3 >/dev/null 2>&1; rc=$?
check "red pipeline: exit 4" test "$rc" = 4

# === 6. confirmed teams ============================================================================
section "teams: custom stages, parallel roles and shared proposal limits"
TP="$(new_project team)"; TN="$TP/state"; export SELFTEST_STATE="$TP/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$TP" none local
# Old state directories still have the default cap after a checkout update.
sed -i '/^MAX_AGENTS=/d' "$TN/shoemaker.conf"
front "$TN" max_waiting 2; front "$TN" per_round 2; front "$TN" max_builds 1
mkdir -p "$TN/team"
cat >"$TN/team/active.json" <<'JSON'
{"version":1,"stages":[
 {"id":"discover","name":"Discover","roles":[{"id":"ideas","name":"Feature suggestions","count":3,"description":"Suggest features","capabilities":["propose"],"authority":"advisory","instructions":"Suggest a small feature."}]},
 {"id":"debate","name":"Debate","roles":[{"id":"reviewers","name":"Feature review","count":2,"description":"Approve unanimously after discussion","capabilities":["review"],"authority":"approve","instructions":"Assess every proposed feature."}]},
 {"id":"make","name":"Make","roles":[{"id":"builders","name":"Implementers","count":2,"description":"Implement approved features","capabilities":["build"],"authority":"advisory","instructions":"Build your item."}]},
 {"id":"reflect","name":"Reflect","roles":[{"id":"writer","name":"Reporter","count":1,"description":"Report on the round","capabilities":["report"],"authority":"advisory","instructions":"Write an analysis report.","model":"haiku","effort":"low"}]}
]}
JSON
check "team CLI validates a config using the absent-key cap default" "$SM" -s "$TN" team validate "$TN/team/active.json"
check "team CLI shows the active stages" bash -c "'$SM' -s '$TN' team | jq -e '.stages | length == 4'"
SELFTEST_PLAN=work SELFTEST_TEAM_PARALLEL=3 "$SM" -s "$TN" run >"$SELFTEST_STATE/team-run.out" 2>&1; trc=$?
check "the custom-stage team round exits successfully" test "$trc" = 0
check "all agents in a stage start in parallel" test -f "$SELFTEST_STATE/parallel-ok"
check "all proposers together respect per_round and max_waiting" bash -c "[ \"\$(SHOEMAKER_STATE='$TN' '$SM' queue list --json | jq length)\" = 2 ]"
check "unanimous agent approval makes both items buildable that round" bash -c "[ \"\$(status_of '$TN' 1)\" = shipped ] && [ \"\$(status_of '$TN' 2)\" = shipped ]"
check "team build count replaces max_builds=1" bash -c "find '$TN/runs' -path '*/make/builders/*/prompt.md' | test \"\$(wc -l)\" = 2"
check "reviewers read and answer the first-turn notes" bash -c "[ -f '$SELFTEST_STATE/discussion-reviewers-1' ] && [ -f '$SELFTEST_STATE/discussion-reviewers-2' ]"
check "non-build roles use restricted read-only tools" bash -c "grep -q -- '--safe-mode --restricted --permission-mode dontAsk --tools Read,Grep,Glob' '$SELFTEST_STATE/claude-calls'"
check "non-build worktree hooks reject commits" bash -c "[ \"\$(cat '$SELFTEST_STATE/team-commit-ideas-1.rc')\" != 0 ] && [ \"\$(cat '$SELFTEST_STATE/team-commit-reviewers-1.rc')\" != 0 ]"
check "report output is saved in the stage and role directory" bash -c "find '$TN/runs' -path '*/reflect/writer/1/report.md' -exec grep -q 'Synthetic analysis' {} \; -print | grep -q ."
check "per-role model and effort reach the process" bash -c "grep -q -- '--model haiku --effort low' '$SELFTEST_STATE/claude-calls'"
check "the round saved its team snapshot" bash -c "find '$TN/runs' -name team.json -exec jq -e '.stages[0].id == \"discover\"' {} \; | grep -q true"

review_team() {  # state, authority, count
  mkdir -p "$1/team"
  jq -n --arg authority "$2" --argjson count "$3" '{version:1,stages:[{id:"discussion",name:"Discussion",roles:[{id:"critics",name:"Critics",count:$count,description:"Review features",capabilities:["review"],authority:$authority,instructions:"Read and discuss the proposed items."}]}]}' >"$1/team/active.json"
}
section "teams: advisory, filter majority and approve unanimity"
RP="$(new_project reviews)"; RN="$RP/state"; export SELFTEST_STATE="$RP/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$RP" none local; front "$RN" max_waiting 0
head -c 140000 /dev/zero | tr '\0' x >"$RN/runs/large-review.md"
SHOEMAKER_STATE="$RN" "$SM" queue add --title "Review this" --body-file "$RN/runs/large-review.md" >/dev/null
review_team "$RN" advisory 2
SELFTEST_TEAM_VERDICTS=approve,approve "$SM" -s "$RN" run >"$SELFTEST_STATE/advisory.out" 2>&1; trc=$?
check "advisory verdicts leave approval with the human" bash -c "[ '$trc' = 0 ] && [ \"\$(status_of '$RN' 1)\" = proposed ]"
check "advisory verdict and authority stay visible in the item log" bash -c "SHOEMAKER_STATE='$RN' '$SM' queue show 1 --json | jq -e '.log | tostring | contains(\"advisory\")'"
review_team "$RN" filter 3
SELFTEST_TEAM_VERDICTS=reject,reject,approve "$SM" -s "$RN" run >"$SELFTEST_STATE/filter.out" 2>&1; trc=$?
check "a filter majority screens the item out" bash -c "[ '$trc' = 0 ] && [ \"\$(status_of '$RN' 1)\" = archived ]"
check "screened items retain filter reasons in the visible log" bash -c "SHOEMAKER_STATE='$RN' '$SM' queue show 1 --json | jq -e '.log | tostring | contains(\"filter\")'"
SHOEMAKER_STATE="$RN" "$SM" queue add --title "Needs unanimous approval" >/dev/null
review_team "$RN" approve 2
SELFTEST_TEAM_VERDICTS=approve,abstain "$SM" -s "$RN" run >"$SELFTEST_STATE/not-unanimous.out" 2>&1; trc=$?
check "a non-unanimous approve stage leaves the item proposed" bash -c "[ '$trc' = 0 ] && [ \"\$(status_of '$RN' 2)\" = proposed ]"
SELFTEST_TEAM_VERDICTS=approve,approve "$SM" -s "$RN" run >"$SELFTEST_STATE/approve.out" 2>&1; trc=$?
check "a unanimous approve stage approves the item" bash -c "[ '$trc' = 0 ] && [ \"\$(status_of '$RN' 2)\" = approved ]"

section "teams: agent cap, mode and the unchanged default round"
review_team "$RN" advisory 17
: >"$SELFTEST_STATE/claude-calls"
"$SM" -s "$RN" run >"$SELFTEST_STATE/cap.out" 2>&1; trc=$?
check "the default 16-agent cap refuses the whole team before starting" bash -c "[ '$trc' != 0 ] && [ ! -s '$SELFTEST_STATE/claude-calls' ]"
review_team "$RN" advisory 3
echo 'MAX_AGENTS=2' >>"$RN/shoemaker.conf"
"$SM" -s "$RN" run >"$SELFTEST_STATE/custom-cap.out" 2>&1; trc=$?
check "a configured lower cap is enforced" bash -c "[ '$trc' != 0 ] && [ ! -s '$SELFTEST_STATE/claude-calls' ]"
check "team validate uses the project's configured cap" bash -c "! '$SM' -s '$RN' team validate '$RN/team/active.json'"
sed -i '/^MAX_AGENTS=/d' "$RN/shoemaker.conf"
# A build-only team still obeys the human's suggest mode.
jq '.stages[0].roles[0] |= (.count=1 | .capabilities=["build"] | .authority="advisory")' "$RN/team/active.json" >"$RN/team/next.json" && mv "$RN/team/next.json" "$RN/team/active.json"
front "$RN" mode suggest
"$SM" -s "$RN" run >/dev/null 2>&1
check "suggest mode disables even a confirmed build role" bash -c "[ ! -s '$SELFTEST_STATE/claude-calls' ] && [ \"\$(status_of '$RN' 2)\" = approved ]"
rm "$RN/team/active.json"
front "$RN" mode ship; front "$RN" max_waiting 5
SELFTEST_PLAN=work "$SM" -s "$RN" run >/dev/null 2>&1; trc=$?
check "removing the active config restores the default two-role round" bash -c "[ '$trc' = 0 ] && [ -f '$SELFTEST_STATE/claude-env-suggestion-agent' ] && [ -f '$SELFTEST_STATE/claude-env-implementation-agent' ] && [ \"\$(status_of '$RN' 2)\" = shipped ]"

section "teams: the landing gate enforces protected round mode"
GP="$(new_project teamgate)"; GN="$GP/state"; export SELFTEST_STATE="$GP/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$GP" none local
mkdir -p "$GN/team/runtime"
git -C "$GP/repo" config extensions.worktreeConfig true
git -C "$GP/repo" worktree add -q -b shoemaker/q1-team "$GN/worktrees/gate" main
GW="$GN/worktrees/gate"
git -C "$GW" config --worktree shoemaker.state "$GN"
git -C "$GW" config --worktree shoemaker.role build
git -C "$GW" config --worktree core.hooksPath "$SM_HOME/harness/guard/git-hooks"
git -C "$GW" config --worktree shoemaker.teamContext "$GN/team/runtime/gate.json"
printf '{"capabilities":["build"],"mode":"review"}\n' >"$GN/team/runtime/gate.json"
echo change >"$GW/change.txt"; git -C "$GW" add change.txt; git -C "$GW" commit -qm "team change"
check "a review team cannot elevate land to ship through its environment" bash -c "cd '$GW' && SHOEMAKER_MODE=ship '$SM' -s '$GN' land open -t test && ! git merge-base --is-ancestor HEAD main"
printf '{"capabilities":["build"],"mode":"ship"}\n' >"$GN/team/runtime/gate.json"
check "a ship team can still lower a risky build to review" bash -c "cd '$GW' && SHOEMAKER_MODE=review '$SM' -s '$GN' land open -t test && ! git merge-base --is-ancestor HEAD main"
printf '{"capabilities":["report"],"mode":"ship"}\n' >"$GN/team/runtime/gate.json"
check "a non-build team role cannot call the landing gate" bash -c "cd '$GW' && ! SHOEMAKER_MODE=ship '$SM' -s '$GN' land open -t test"
printf '{"capabilities":["build"],"mode":"suggest"}\n' >"$GN/team/runtime/gate.json"
check "a suggest team context refuses publication despite a ship environment" bash -c "cd '$GW' && ! SHOEMAKER_MODE=ship '$SM' -s '$GN' land open -t test"

# === 7. optional auto approval =====================================================================
section "auto approval: snapshot, parallel workers and read-only guard"
AP="$(new_project autoapproval)"; AN="$AP/state"; export SELFTEST_STATE="$AP/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$AP" none local
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Waiting at round start" --priority low >/dev/null
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Already approved" >/dev/null; approve "$AN" 2
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/off.out" 2>&1; arc=$?
check "manual approval is the default and starts no approver" bash -c "[ '$arc' = 0 ] && [ ! -s '$SELFTEST_STATE/claude-calls' ] && [ \"\$(status_of '$AN' 1)\" = proposed ]"
auto_approve "$AN" 1
SELFTEST_PLAN=work SELFTEST_APPROVAL_PARALLEL=3 "$SM" -s "$AN" run >"$SELFTEST_STATE/parallel.out" 2>&1; arc=$?
check "the approver starts alongside suggestion and build workers" bash -c "[ '$arc' = 0 ] && test -f '$SELFTEST_STATE/approval-parallel-ok'"
check "the snapshot is approved with Auto priority and existing builds finish" bash -c "SHOEMAKER_STATE='$AN' '$SM' queue show 1 --json | jq -e '.status == \"approved\" and .priority == 0 and .suggested_priority == 3' && [ \"\$(status_of '$AN' 2)\" = shipped ]"
check "suggestions from the same round wait for a later approver" bash -c "[ \"\$(status_of '$AN' 3)\" = proposed ]"
ADIR="$(find "$AN/runs" -path '*/approve/context.json' -printf '%h\n' | sort | tail -n 1)"
check "approver records include its prompt, transcript, response, effects and summary" bash -c "test -s '$ADIR/prompt.md' -a -s '$ADIR/transcript.jsonl' -a -s '$ADIR/response.json' -a -s '$ADIR/applied.json' -a -s '$ADIR/summary.md'"
check "the approver receives restricted read-only tools and a result schema" bash -c "grep -q -- '--safe-mode --restricted --permission-mode dontAsk --tools Read,Grep,Glob' '$SELFTEST_STATE/approve-calls' && grep -q -- '--json-schema' '$SELFTEST_STATE/approve-calls'"
check "the approver cannot commit or apply its own result" bash -c "[ \"\$(cat '$SELFTEST_STATE/approve-commit.rc')\" != 0 ] && [ \"\$(cat '$SELFTEST_STATE/approve-apply.rc')\" != 0 ]"
check "the guard still blocks a direct change to the mode in queue.db" blocked "$(bash_json "sqlite3 $AN/queue.db 'UPDATE config SET auto_approve=1'")"
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"; : >"$SELFTEST_STATE/approve-calls"
SELFTEST_APPROVAL_FLIP=off "$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/only.out" 2>&1; arc=$?
check "--only approve starts exactly the approver and an in-round mode flip does not cancel it" bash -c "[ '$arc' = 0 ] && [ \"\$(wc -l <'$SELFTEST_STATE/agent-starts')\" = 1 ] && [ \"\$(status_of '$AN' 3)\" = approved ]"
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Next round sees manual mode" >/dev/null
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/flipped.out" 2>&1
check "the next round observes the mode flipped off" bash -c "[ ! -s '$SELFTEST_STATE/claude-calls' ] && [ \"\$(status_of '$AN' 4)\" = proposed ]"
auto_approve "$AN" 1
SELFTEST_APPROVAL_VERDICT=abstain "$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/hold.out" 2>&1
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/held.out" 2>&1
check "unchanged held ideas do not restart the approver" bash -c "[ ! -s '$SELFTEST_STATE/claude-calls' ] && [ \"\$(status_of '$AN' 4)\" = proposed ] && grep -q 'not this round' '$AN/runs/idle.log'"
SHOEMAKER_STATE="$AN" "$SM" queue note 4 "The spec now has a clear verification plan." >/dev/null
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/changed.out" 2>&1
check "new notes make a held idea eligible for another examination" bash -c "[ -s '$SELFTEST_STATE/claude-calls' ] && [ \"\$(status_of '$AN' 4)\" = approved ]"
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/empty.out" 2>&1
check "nothing waiting starts no approver and keeps the not-this-round log" bash -c "[ ! -s '$SELFTEST_STATE/claude-calls' ] && grep -q 'not this round' '$AN/runs/idle.log'"

section "auto approval: settings, selection and dry run"
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Settings checks" >/dev/null
front "$AN" mode suggest
direction_setting "$AN" model sonnet; direction_setting "$AN" effort high
direction_setting "$AN" approve_model haiku; direction_setting "$AN" approve_effort low
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"; : >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$AN" run --only approve --dry-run >"$SELFTEST_STATE/dry.out" 2>&1; arc=$?
check "a dry approver round writes a prompt without starting or claiming anything" bash -c "[ '$arc' = 0 ] && [ ! -s '$SELFTEST_STATE/claude-calls' ] && [ \"\$(status_of '$AN' 5)\" = proposed ] && find '$AN/runs' -path '*dry*/approve/prompt.md' | grep -q ."
direction_setting "$AN" approve_model ""; direction_setting "$AN" approve_effort ""
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/fallback.out" 2>&1
check "approver settings fall back to model/effort and run in suggest mode" bash -c "grep -q -- '--model sonnet --effort high' '$SELFTEST_STATE/approve-calls' && [ \"\$(status_of '$AN' 5)\" = approved ]"
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Dedicated settings" >/dev/null
direction_setting "$AN" approve_model haiku; direction_setting "$AN" approve_effort low
: >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/settings.out" 2>&1
check "approve_model and approve_effort override the default worker settings" grep_q "--model haiku --effort low" "$SELFTEST_STATE/approve-calls"
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Command line overrides" >/dev/null
: >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$AN" run --only approve --model opus --effort max >"$SELFTEST_STATE/override.out" 2>&1
check "--model and --effort also override the approver" grep_q "--model opus --effort max" "$SELFTEST_STATE/approve-calls"
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Claude default settings" >/dev/null
direction_setting "$AN" model ""; direction_setting "$AN" effort ""
direction_setting "$AN" approve_model ""; direction_setting "$AN" approve_effort ""
: >"$SELFTEST_STATE/approve-calls"
env -u SHOEMAKER_MODEL -u SHOEMAKER_EFFORT "$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/defaults.out" 2>&1
check "empty settings omit model and effort flags for Claude's defaults" bash -c "test -s '$SELFTEST_STATE/approve-calls' && ! grep -qE -- '--model|--effort' '$SELFTEST_STATE/approve-calls'"
SHOEMAKER_STATE="$AN" "$SM" queue add --title "Invalid effort cannot launch" >/dev/null
direction_setting "$AN" approve_effort invalid
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/invalid.out" 2>&1; arc=$?
check "invalid approve_effort fails before any agent starts" bash -c "[ '$arc' != 0 ] && [ ! -s '$SELFTEST_STATE/claude-calls' ] && grep -q 'effort must be' '$SELFTEST_STATE/invalid.out'"
direction_setting "$AN" approve_effort ""
front "$AN" enabled false
"$SM" -s "$AN" run --only approve >"$SELFTEST_STATE/paused.out" 2>&1
check "enabled false pauses auto approval with the round" bash -c "[ ! -s '$SELFTEST_STATE/claude-calls' ] && grep -q 'enabled: false' '$SELFTEST_STATE/paused.out'"
front "$AN" enabled true
: >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$AN" run --only suggest >"$SELFTEST_STATE/suggest-only.out" 2>&1
"$SM" -s "$AN" run --only implement >"$SELFTEST_STATE/implement-only.out" 2>&1
check "--only suggest and --only implement exclude auto approval" bash -c "[ ! -s '$SELFTEST_STATE/approve-calls' ] && [ \"\$(status_of '$AN' 9)\" = proposed ]"

section "auto approval: default and team agent caps"
CP="$(new_project approvalcap)"; CN="$CP/state"; export SELFTEST_STATE="$CP/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$CP" none local; auto_approve "$CN" 1; front "$CN" max_builds 2
sed -i 's/^MAX_AGENTS=.*/MAX_AGENTS=2/' "$CN/shoemaker.conf"
for title in waiting first-build second-build; do SHOEMAKER_STATE="$CN" "$SM" queue add --title "$title" >/dev/null; done
approve "$CN" 2; approve "$CN" 3
SELFTEST_PLAN=work "$SM" -s "$CN" run >"$SELFTEST_STATE/cap.out" 2>&1
check "default scheduling reserves suggestion and approval slots before builds" bash -c "[ \"\$(wc -l <'$SELFTEST_STATE/agent-starts')\" = 2 ] && [ \"\$(status_of '$CN' 1)\" = approved ] && [ \"\$(status_of '$CN' 2)\" = approved ] && [ \"\$(status_of '$CN' 3)\" = approved ]"
sed -i 's/^MAX_AGENTS=.*/MAX_AGENTS=1/' "$CN/shoemaker.conf"
: >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$CN" run >"$SELFTEST_STATE/full.out" 2>&1
check "the approver skips when the suggestion agent fills the only slot" bash -c "[ ! -s '$SELFTEST_STATE/approve-calls' ] && grep -q 'auto-approval agent: not this round.*MAX_AGENTS' '$SELFTEST_STATE/full.out'"

ATP="$(new_project approvalteam)"; ATN="$ATP/state"; export SELFTEST_STATE="$ATP/selftest"; mkdir -p "$SELFTEST_STATE"
setup "$ATP" none local; auto_approve "$ATN" 1
sed -i 's/^MAX_AGENTS=.*/MAX_AGENTS=3/' "$ATN/shoemaker.conf"
mkdir -p "$ATN/team"
cat >"$ATN/team/active.json" <<'JSON'
{"version":1,"stages":[{"id":"work","name":"Work","roles":[
  {"id":"writer","name":"Reporter","count":1,"description":"Report","capabilities":["report"],"authority":"advisory","instructions":"Write a report."},
  {"id":"builders","name":"Build","count":2,"description":"Implement approved items","capabilities":["build"],"authority":"advisory","instructions":"Build the assigned item."}
]}]}
JSON
for title in waiting first-build second-build; do SHOEMAKER_STATE="$ATN" "$SM" queue add --title "$title" >/dev/null; done
approve "$ATN" 2; approve "$ATN" 3
SELFTEST_PLAN=work SELFTEST_APPROVAL_PARALLEL=3 "$SM" -s "$ATN" run >"$SELFTEST_STATE/team-cap.out" 2>&1; arc=$?
check "a full team yields one build slot and starts approval beside its first stage" bash -c "[ '$arc' = 0 ] && [ \"\$(wc -l <'$SELFTEST_STATE/agent-starts')\" = 3 ] && test -f '$SELFTEST_STATE/approval-parallel-ok' && [ \"\$(status_of '$ATN' 1)\" = approved ] && [ \"\$(status_of '$ATN' 2)\" = shipped ] && [ \"\$(status_of '$ATN' 3)\" = approved ]"
SHOEMAKER_STATE="$ATN" "$SM" queue add --title "No team build slot can yield" >/dev/null
review_team "$ATN" advisory 3
: >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$ATN" run >"$SELFTEST_STATE/no-build.out" 2>&1
check "a full team without builds skips approval and explains the cap" bash -c "[ ! -s '$SELFTEST_STATE/approve-calls' ] && grep -q 'auto-approval agent: not this round.*MAX_AGENTS' '$SELFTEST_STATE/no-build.out' && [ \"\$(status_of '$ATN' 4)\" = proposed ]"
: >"$SELFTEST_STATE/claude-calls"; : >"$SELFTEST_STATE/agent-starts"; : >"$SELFTEST_STATE/approve-calls"
"$SM" -s "$ATN" run --only approve >"$SELFTEST_STATE/team-only.out" 2>&1; arc=$?
check "--only approve bypasses the active team and its full roster" bash -c "[ '$arc' = 0 ] && [ \"\$(wc -l <'$SELFTEST_STATE/agent-starts')\" = 1 ] && [ \"\$(status_of '$ATN' 4)\" = approved ]"

# === 8. update =====================================================================================
section "update: an installed checkout and its upstream"
if git -C "$SM_HOME" rev-parse --git-dir >/dev/null 2>&1; then
  # An upstream holding this tree, an install cloned from it, and stand-ins for systemctl
  # (the dashboards are active, the rounds are not) and npm.
  U="$T/upstream"; I="$T/install"; mkdir -p "$U"
  (cd "$SM_HOME" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$U"
  git -C "$U" init -q -b main && git -C "$U" add -A && git -C "$U" commit -qm "v1"
  git clone -q "$U" "$I" && ln -s "$SM_HOME/dashboard/node_modules" "$I/dashboard/node_modules"
  P="$(new_project upd)"; N="$P/state"; export SELFTEST_STATE="$P/selftest"; mkdir -p "$SELFTEST_STATE"
  cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SELFTEST_STATE/systemctl-calls"
case "$*" in *is-active*-dashboard.service*) exit 0 ;; *is-active*) exit 3 ;; esac
EOF
  printf '#!/usr/bin/env bash\necho "$*" >>"$SELFTEST_STATE/npm-calls"\n' >"$STUBS/npm"
  chmod +x "$STUBS/systemctl" "$STUBS/npm"
  "$I/bin/shoemaker" init "$N" PROJECT=upd REPO="$P/repo" HOST=none DEFAULT_BRANCH=main GATE=none >/dev/null
  "$I/bin/shoemaker" -s "$N" schedule "*-*-* 03:30:00" --timezone Asia/Seoul >/dev/null
  "$I/bin/shoemaker" -s "$N" install >/dev/null 2>&1
  P2="$(new_project other)"; setup "$P2" none none && "$SM" -s "$P2/state" install >/dev/null 2>&1
  : >"$SELFTEST_STATE/systemctl-calls"
  # v2 also rewrites bin/shoemaker, the script that is running the update.
  echo "# v2" >>"$U/harness/SUGGEST.md"; sed -i 's/^# shoemaker — /# shoemaker: /' "$U/bin/shoemaker"
  git -C "$U" commit -qam "v2: protocols"
  v1="$(git -C "$I" rev-parse HEAD)"
  check "version names the commit" bash -c "'$I/bin/shoemaker' version | grep -q \"$(git -C "$I" rev-parse --short HEAD)\""
  check "status names the checkout the units run" bash -c "'$SM' -s '$N' status | grep -q 'shoemaker:  $I (the units run it'"
  check "--check lists the new commit and the project, and changes nothing" bash -c "
    out=\"\$('$I/bin/shoemaker' update --check)\" && grep -q 'v2: protocols' <<<\"\$out\" && grep -q 'run it: shoemaker-upd\$' <<<\"\$out\" &&
    [ \"\$(git -C '$I' rev-parse HEAD)\" = '$v1' ]"
  check "a running round blocks it" bash -c "
    exec 8>'$N/.lock'; flock 8; out=\"\$('$I/bin/shoemaker' update 2>&1)\" && exit 1
    grep -q 'round of shoemaker-upd is running' <<<\"\$out\" && [ \"\$(git -C '$I' rev-parse HEAD)\" = '$v1' ]"
  echo local >>"$I/README.md"
  check "local changes block it" bash -c "! '$I/bin/shoemaker' update && [ \"\$(git -C '$I' rev-parse HEAD)\" = '$v1' ]"
  git -C "$I" checkout -q README.md
  check "update: fast-forwards and exits cleanly" "$I/bin/shoemaker" update
  check "...to the upstream commit" test "$(git -C "$I" rev-parse HEAD)" = "$(git -C "$U" rev-parse HEAD)"
  check "...restarts the dashboard of the project that runs it" grep_q "restart shoemaker-upd-dashboard.service" "$SELFTEST_STATE/systemctl-calls"
  check "...and not one that runs another checkout" bash -c "! grep -q shoemaker-other '$SELFTEST_STATE/systemctl-calls'"
  check "...and skips npm ci when the lockfile is the same" test ! -e "$SELFTEST_STATE/npm-calls"
  echo >>"$U/dashboard/package-lock.json"; git -C "$U" commit -qam "v3: dependencies"
  check "a new lockfile runs npm ci" bash -c "'$I/bin/shoemaker' update && grep -qx 'ci --no-audit --no-fund' '$SELFTEST_STATE/npm-calls'"
  check "then it is up to date" bash -c "'$I/bin/shoemaker' update | grep -q 'up to date'"
  # One project moves to another checkout: schedule and install from that one.
  : >"$SELFTEST_STATE/systemctl-calls"
  "$SM" -s "$N" schedule "*-*-* 03:30:00" --timezone Asia/Seoul >/dev/null && "$SM" -s "$N" install >/dev/null 2>&1
  check "schedule and install move a project to another checkout" bash -c "
    grep -q '^ExecStart=\"$SM_HOME/bin/shoemaker\"' '$N/systemd/shoemaker-upd.service' &&
    grep -q 'restart shoemaker-upd-dashboard.service' '$SELFTEST_STATE/systemctl-calls'"
  echo "# v4" >>"$U/harness/SUGGEST.md"; git -C "$U" commit -qam "v4"; : >"$SELFTEST_STATE/systemctl-calls"
  check "...and the old checkout's update leaves it alone" bash -c "
    '$I/bin/shoemaker' update | grep -q 'run it: none installed' && ! grep -q restart '$SELFTEST_STATE/systemctl-calls'"
  rm -f "$STUBS/systemctl" "$STUBS/npm"
else
  echo "  (skipped: $SM_HOME is not a git checkout)"
fi

echo; echo "selftest: $pass passed, $fail failed"
[ "$fail" = 0 ]
