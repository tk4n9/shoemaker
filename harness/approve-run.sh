#!/usr/bin/env bash
# Sourced by run.sh. Approval uses the same read-only worker and result protocol
# as team review, with a round-start snapshot and no discussion turn.

decide_approve() {
  want_approve=0 approve_pid="" approve_yield_stage="" approve_yield_role=""
  if [ "$only" = suggest ] || [ "$only" = implement ]; then
    say "auto-approval agent: not this round (--only $only)"
  elif ! jq -e '.enabled' "$RUN_DIR/approval.json" >/dev/null; then
    say "auto-approval agent: not this round (manual approval is on)"
  elif [ "$(jq '.items | length' "$RUN_DIR/approval.json")" = 0 ]; then
    say "auto-approval agent: not this round (nothing new or changed to examine)"
  else
    want_approve=1
  fi
}

reserve_team_approve() {
  [ "$want_approve" = 1 ] || return 0
  local count yield
  count="$(jq --arg off "$impl_off" '[.stages[].roles[] | select($off == "" or (.capabilities | index("build") | not)) | .count] | add // 0' <<<"$team_config")"
  [ "$count" -ge "$MAX_AGENTS" ] || return 0
  yield="$(jq -r '[.stages[] | .id as $stage | .roles[] | select(.capabilities | index("build")) | [$stage,.id]] | last // [] | @tsv' <<<"$team_config")"
  if [ -n "$yield" ] && [ -z "$impl_off" ]; then
    IFS=$'\t' read -r approve_yield_stage approve_yield_role <<<"$yield"
    say "auto-approval agent: reserves one MAX_AGENTS slot from team build role $approve_yield_stage/$approve_yield_role"
  else
    want_approve=0
    say "auto-approval agent: not this round (MAX_AGENTS is $MAX_AGENTS; no team build can give way)"
  fi
}

prepare_approve() {
  [ "$want_approve" = 1 ] || return 0
  A_DIR="$RUN_DIR/approve" A_WT="$WT_ROOT/$run_id-approve"
  mkdir -p "$A_DIR" "$(dirname "$(team_context_path "$A_DIR")")"
  jq --arg run "$run_id" --arg mode "$mode" '{run_id:$run,mode:$mode,stage_id:"@auto-approval",
    role_id:"approve",role_name:"auto-approval agent",agent_id:"approve-1",author:"auto-approval agent",
    capabilities:["review"],authority:"approve",auto_approval:true,per_round:0,max_waiting:0,items:.items}' \
    "$RUN_DIR/approval.json" >"$(team_context_path "$A_DIR")"
  cp "$(team_context_path "$A_DIR")" "$A_DIR/context.json"
  printf '%s' "$a_model" >"$A_DIR/model"; printf '%s' "$a_effort" >"$A_DIR/effort"
  {
    printf '# Shoemaker round %s: auto-approval agent\n\n' "$run_id"
    printf -- '- Your read-only checkout and working directory: `%s`; base: `%s`.\n' "$A_WT" "$base_sha"
    printf -- '- Model: %s; effort: %s; deadline: %s.\n' "${a_model:-default}" "${a_effort:-default}" "$(deadline "$SUGGEST_TIMEOUT")"
    cat "$HARNESS/APPROVE.md"
    printf '\n## Ideas to examine (round-start snapshot, including item notes)\n\n```json\n'
    jq '.items' "$RUN_DIR/approval.json"
    printf '```\n'
    quoted_files
  } >"$A_DIR/prompt.md"
  say "auto-approval agent: $(jq '.items | length' "$RUN_DIR/approval.json") idea(s) to examine"
}

run_approve() {
  local rc=0
  if ! gitl -C "$REPO" worktree add -q --detach "$A_WT" "$base" >>"$RUNLOG" 2>&1; then
    printf '# Auto approval — %s\n\nCould not create the read-only worktree; see run.log.\n' "$run_id" >"$A_DIR/summary.md"
    say "auto-approval agent: could not create worktree"; return 1
  fi
  gitl -C "$REPO" worktree lock --reason "shoemaker approval $run_id" "$A_WT"
  if guard_worktree "$A_WT" report && git -C "$A_WT" config --worktree shoemaker.teamContext "$(team_context_path "$A_DIR")"; then
    say "auto-approval agent: starting claude (model ${a_model:-default}, effort ${a_effort:-default}, timeout $SUGGEST_TIMEOUT)"
    team_start_readonly "$A_DIR" "$A_WT" && team_apply_readonly "$A_DIR" || rc=1
  else
    say "auto-approval agent: guard or protected context unavailable"; rc=1
  fi
  {
    printf '# Auto approval — %s\n\n' "$run_id"
    if [ "$rc" = 0 ]; then
      jq -r '"Approved: " + (.approved | map("#" + tostring) | join(", ")),
        "Held: " + (.held | map("#" + tostring) | join(", ")),
        "Skipped (no verdict, or changed or decided meanwhile; examined again next round): " + (.skipped | map("#" + tostring) | join(", "))' "$A_DIR/applied.json"
    else
      printf 'Agent, guard or result failed; see stderr.log and run.log.\n'
    fi
  } >"$A_DIR/summary.md"
  gitl -C "$REPO" worktree unlock "$A_WT" 2>/dev/null || true
  cleanup_worktree "$A_WT"
  say "auto-approval agent: finished (exit $rc); see $A_DIR/summary.md"
  return "$rc"
}

start_approve() {
  if [ "$want_approve" = 1 ] && [ "$dry_run" = 0 ]; then
    run_approve & approve_pid=$!
  fi
}

finish_approve() {
  [ -z "$approve_pid" ] || wait "$approve_pid"
}
