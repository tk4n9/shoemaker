#!/usr/bin/env bash
# Sourced by run.sh after its preflight. The active team has already been
# validated and snapshotted; only this copy is used until the round ends.

T() { SHOEMAKER_STATE="$STATE" node "$SHOEMAKER_HOME/dashboard/bin/team.mjs" "$@"; }

team_context_path() {
  local path="${1#"$RUN_DIR/stages/"}"
  [ "$1" = "$RUN_DIR/approve" ] && path=approve
  printf '%s/team/runtime/%s/%s.json\n' "$STATE" "$run_id" "$path"
}

team_queue_snapshot() {
  local id
  while read -r id; do
    Q show "$id" --json
  done < <(Q list --json | jq -r '.[].id') | jq -s .
}

team_context_file() {  # role JSON, agent number, output path
  local role="$1" number="$2" out="$3"
  mkdir -p "$(dirname "$out")"
  jq -n --argjson role "$role" --argjson reviewers "$team_reviewers" \
    --arg run "$run_id" --arg mode "$mode" --arg stage "$team_stage_id" --arg agent "$(jq -r .id <<<"$role")-$number" \
    --argjson waiting "$max_waiting" --argjson limit "$per_round" \
    '{run_id:$run,mode:$mode,stage_id:$stage,role_id:$role.id,role_name:$role.name,agent_id:$agent,
      capabilities:$role.capabilities,authority:$role.authority,instructions:$role.instructions,
      max_waiting:$waiting,per_round:$limit,reviewers:$reviewers}' >"$out"
}

team_readonly_prompt() {  # role JSON, agent directory, worktree
  local role="$1" dir="$2" wt="$3"
  {
    printf '# Shoemaker round %s: team agent\n\n' "$run_id"
    printf -- '- Stage: %s; role: %s; agent: %s\n' "$team_stage_id" "$(jq -r .name <<<"$role")" "$(jq -r .agent_id "$(team_context_path "$dir")")"
    printf -- '- Capabilities: %s; review authority: %s\n' "$(jq -r '.capabilities | join(", ")' <<<"$role")" "$(jq -r .authority <<<"$role")"
    printf -- '- Your read-only checkout and working directory: `%s`; base: `%s`. Read code relative to this checkout.\n' "$wt" "$base_sha"
    printf -- '- Model: %s; effort: %s; deadline: %s (all discussion turns share this budget)\n' "${role_model:-default}" "${role_effort:-default}" "$(deadline "$SUGGEST_TIMEOUT")"
    printf -- '- New proposals across ALL roles: at most %s this round, with at most %s waiting.\n' "$per_round" "$max_waiting"
    printf '\n## Role instructions\n\n%s\n\n' "$(jq -r .instructions <<<"$role")"
    cat "$HARNESS/TEAM.md"
    printf '\n## Current queue (including item notes)\n\n```json\n'
    cat "$team_stage_dir/queue.json"
    printf '\n```\n\n## Recent ledger\n\n'
    tail -n 100 "$LEDGER"
    quoted_files
  } >"$dir/prompt.md"
}

team_readonly_turn() {  # dir, worktree, timeout seconds, prompt file, optional session
  local dir="$1" wt="$2" seconds="$3" prompt="$4" session="${5:-}" args=() extra_env=() rc role_model role_effort
  role_model="$(cat "$dir/model")"; role_effort="$(cat "$dir/effort")"
  while IFS= read -r -d '' a; do args+=("$a"); done < <(model_args "$role_model" "$role_effort")
  [ -n "$session" ] && args+=(--resume "$session")
  # shellcheck disable=SC2206
  [ -n "${AGENT_ENV:-}" ] && extra_env=($AGENT_ENV)
  ( cd "$wt" && env "${extra_env[@]}" PATH="$SHOEMAKER_HOME/bin:$PATH" SHOEMAKER_STATE="$STATE" \
      SHOEMAKER_AUTHOR="$(jq -r '.author // ("team " + .agent_id)' "$(team_context_path "$dir")")" SHOEMAKER_RUN_ID="$run_id" \
      SHOEMAKER_TEAM_CONTEXT="$(team_context_path "$dir")" SHOEMAKER_MODE="$mode" \
      timeout --kill-after=2m "$seconds" claude -p "${args[@]}" \
      "${claude_guard[@]}" --safe-mode --restricted --permission-mode dontAsk --tools Read,Grep,Glob \
      --no-chrome --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands \
      --json-schema "$(cat "$HARNESS/team-result.schema.json")" --output-format stream-json --verbose \
  ) <"$prompt" >"$dir/turn.jsonl" 2>>"$dir/stderr.log"
  rc=$?
  cat "$dir/turn.jsonl" >>"$dir/transcript.jsonl"
  if [ "$rc" = 0 ]; then
    jq -s -e '[.[] | select(.type == "result" and .is_error != true)] | last // error("no successful result")' \
      "$dir/turn.jsonl" >"$dir/response.json" || rc=1
  fi
  printf '%s\n' "$rc" >"$dir/exit-code"
  [ "$rc" = 0 ] || say "team $(jq -r .agent_id "$(team_context_path "$dir")"): turn failed (exit $rc); see $dir/stderr.log"
  return "$rc"
}

team_start_readonly() {  # directory, worktree
  local dir="$1" wt="$2"
  date +%s >"$dir/started"
  team_readonly_turn "$dir" "$wt" "$(to_seconds "$SUGGEST_TIMEOUT")" "$dir/prompt.md"
}

team_apply_readonly() {
  local dir="$1"
  [ "$(cat "$dir/exit-code" 2>/dev/null)" = 0 ] || return 1
  if T apply-result "$(team_context_path "$dir")" "$dir/response.json" >"$dir/applied.json" 2>>"$dir/stderr.log"; then
    jq -r '.report // empty' "$dir/applied.json" >"$dir/report.md"
    jq -r '.result // empty' "$dir/response.json" >"$dir/result.md"
    return 0
  fi
  say "team $(jq -r .agent_id "$(team_context_path "$dir")"): invalid or refused result; see $dir/stderr.log"
  return 1
}

team_reply() {  # directory, worktree
  local dir="$1" wt="$2" sid left
  [ "$(cat "$dir/exit-code" 2>/dev/null)" = 0 ] || return 1
  sid="$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id // empty' "$dir/transcript.jsonl" | head -n 1)"
  [ -n "$sid" ] || { say "team: no saved session for $dir; keeping first review"; return 0; }
  left=$(( $(to_seconds "$SUGGEST_TIMEOUT") - $(date +%s) + $(cat "$dir/started") ))
  [ "$left" -gt 0 ] || { say "team: discussion deadline reached for $dir"; return 1; }
  {
    printf '# Discussion turn\n\nRead and answer the other reviewers\047 notes below. Return your final verdict and an explanation for each waiting item, using the same JSON schema. Keep your role authority. Do not repeat proposals from your first turn.\n\n'
    cat "$team_stage_dir/discussion.json"
  } >"$dir/reply.md"
  team_readonly_turn "$dir" "$wt" "$left" "$dir/reply.md" "$sid"
}

team_round() {
  local stage role sid rid count n i index wt dir m e rc=0 stage_rc=0 old_model="$model" old_effort="$effort"
  local stage_count team_build_limit team_used_ids="" agent_dirs=() agent_wts=() pids=() review_pids=() build_pids=() review_dirs=() review_wts=()
  local team_build_dirs=() team_build_contexts=() team_build_models=() team_build_efforts=()
  stage_count="$(jq '.stages | length' <<<"$team_config")"
  say "team: $stage_count stage(s), $(jq '[.stages[].roles[].count] | add' <<<"$team_config") agents (cap $MAX_AGENTS)"
  for ((sid=0; sid<stage_count; sid++)); do
    base_sha="$(git -C "$REPO" rev-parse --verify "$base")" || { finish_approve; return 1; }
    stage="$(jq -c ".stages[$sid]" <<<"$team_config")"
    team_stage_id="$(jq -r .id <<<"$stage")"
    team_stage_dir="$RUN_DIR/stages/$team_stage_id"
    mkdir -p "$team_stage_dir"
    team_reviewers="$(jq -c '[.roles[] | select(.capabilities | index("review")) | . as $r | range(1;.count+1) | {agent_id:($r.id+"-"+tostring),authority:$r.authority}]' <<<"$stage")"
    team_queue_snapshot >"$team_stage_dir/queue.json"
    printf '%s\n' "$stage" >"$team_stage_dir/stage.json"
    team_build_dirs=() team_build_contexts=() team_build_models=() team_build_efforts=()
    agent_dirs=() agent_wts=() review_dirs=() review_wts=() pids=() review_pids=() build_pids=() stage_rc=0 index=0
    team_build_limit="$(jq '[.roles[] | select(.capabilities | index("build")) | .count] | add // 0' <<<"$stage")"
    [ "$team_stage_id" = "$approve_yield_stage" ] && team_build_limit=$((team_build_limit - 1))
    picks='{"items":[]}'
    if [ "$team_build_limit" -gt 0 ] && [ "$only" != suggest ] && [ -z "$impl_off" ]; then
      if [ "$dry_run" = 1 ]; then
        picks="$(Q next --max "$team_build_limit" --exclude "$team_used_ids" --json)"
      else
        picks="$(Q pick --run "$run_id" --max "$team_build_limit" --exclude "$team_used_ids" --json)"
      fi
      [ -n "$picks" ] || picks='{"items":[]}'
    fi
    n_builds="$(jq '.items | length' <<<"$picks")"
    say "team stage $team_stage_id: $n_builds build(s), $(jq '.roles | length' <<<"$stage") role(s)"
    # First-stage picks are fixed before approval starts; later stages may use it.
    [ "$sid" = 0 ] && start_approve
    while IFS= read -r role; do
      rid="$(jq -r .id <<<"$role")"; count="$(jq -r .count <<<"$role")"
      if [ "$team_stage_id" = "$approve_yield_stage" ] && [ "$rid" = "$approve_yield_role" ]; then count=$((count - 1)); fi
      for ((n=1; n<=count; n++)); do
        dir="$team_stage_dir/$rid/$n"
        mkdir -p "$dir"
        team_context_file "$role" "$n" "$(team_context_path "$dir")"
        cp "$(team_context_path "$dir")" "$dir/context.json"
        role_model="${model_override:-$(jq -r '.model // empty' <<<"$role")}"; role_model="${role_model:-$old_model}"
        role_effort="${effort_override:-$(jq -r '.effort // empty' <<<"$role")}"; role_effort="${role_effort:-$old_effort}"
        printf '%s' "$role_model" >"$dir/model"; printf '%s' "$role_effort" >"$dir/effort"
        if jq -e '.capabilities | index("build")' <<<"$role" >/dev/null; then
          if [ "$index" -ge "$n_builds" ]; then continue; fi
          team_build_dirs+=("$dir") team_build_contexts+=("$(team_context_path "$dir")")
          team_build_models+=("$role_model") team_build_efforts+=("$role_effort")
          build_vars "$index"
          jq --argjson id "$item_id" '. + {item_id:$id}' "$team_context" >"$team_context.tmp" && mv "$team_context.tmp" "$team_context"
          cp "$team_context" "$dir/context.json"
          team_used_ids="${team_used_ids:+$team_used_ids,}$item_id"
          write_impl_prompt
          index=$((index + 1))
          [ "$dry_run" = 1 ] && continue
          if ! gitl -C "$REPO" worktree add -q -b "$BRANCH" "$WT" "$base" >>"$RUNLOG" 2>&1; then
            Q release "$item_id" --note "team could not create worktree for $B" >/dev/null 2>&1 || true
            stage_rc=1; continue
          fi
          gitl -C "$REPO" worktree lock --reason "shoemaker team $run_id" "$WT"
          if ! guard_worktree "$WT" build; then
            gitl -C "$REPO" worktree unlock "$WT" 2>/dev/null || true
            cleanup_worktree "$WT"
            Q release "$item_id" --note "team guard unavailable for $B" >/dev/null 2>&1 || true
            stage_rc=1; continue
          fi
          if ! git -C "$WT" config --worktree shoemaker.teamContext "$team_context"; then
            gitl -C "$REPO" worktree unlock "$WT" 2>/dev/null || true
            cleanup_worktree "$WT"
            Q release "$item_id" --note "team context could not be installed for $B" >/dev/null 2>&1 || true
            stage_rc=1; continue
          fi
          run_build "$((index - 1))" & build_pids+=("$!")
        elif [ "$(jq -r '.builtin // empty' <<<"$role")" = suggest ]; then
          # The built-in Suggestion role is the standard suggestion agent
          # (SUGGEST.md), with the focus its description adds.
          [ "$only" = implement ] && continue
          suggest_room
          if [ "$ideas" -eq 0 ]; then
            say "team $rid: suggestion agent not this round ($waiting waiting for your review; max_waiting is $max_waiting)"; continue
          fi
          m="$(jq -r '.model // empty' <<<"$role")"; e="$(jq -r '.effort // empty' <<<"$role")"
          s_model="${model_override:-${m:-$s_model}}" s_effort="${effort_override:-${e:-$s_effort}}"
          S_DIR="$dir" S_WT="$WT_ROOT/$run_id-suggest"
          write_suggest_prompt "$(jq -r '"Role: " + .name + "\n\nFocus from the human\u0027s description of this role:\n\n" + .instructions' <<<"$role")"
          [ "$dry_run" = 1 ] && continue
          team_context="" run_suggest & pids+=("$!")
        else
          [ "$only" = implement ] && continue
          wt="$WT_ROOT/$run_id-$team_stage_id-$rid-$n"
          team_readonly_prompt "$role" "$dir" "$wt"
          [ "$dry_run" = 1 ] && continue
          if ! gitl -C "$REPO" worktree add -q --detach "$wt" "$base" >>"$RUNLOG" 2>&1; then stage_rc=1; continue; fi
          gitl -C "$REPO" worktree lock --reason "shoemaker team $run_id" "$wt"
          if ! guard_worktree "$wt" report || ! git -C "$wt" config --worktree shoemaker.teamContext "$(team_context_path "$dir")"; then
            gitl -C "$REPO" worktree unlock "$wt" 2>/dev/null || true
            cleanup_worktree "$wt"
            stage_rc=1; continue
          fi
          agent_dirs+=("$dir") agent_wts+=("$wt")
          team_start_readonly "$dir" "$wt" & worker_pid=$!
          if jq -e '.capabilities | index("review")' <<<"$role" >/dev/null; then
            review_dirs+=("$dir") review_wts+=("$wt") review_pids+=("$worker_pid")
          else
            pids+=("$worker_pid")
          fi
        fi
      done
    done < <(jq -c '.roles[]' <<<"$stage")
    for i in "${review_pids[@]}"; do wait "$i" || stage_rc=1; done
    for dir in "${review_dirs[@]}"; do team_apply_readonly "$dir" || stage_rc=1; done
    # Each reviewer first works independently. Then the same sessions see the
    # complete first-turn thread and reply in parallel before votes are settled.
    if [ "${#review_dirs[@]}" -gt 1 ]; then
      team_queue_snapshot >"$team_stage_dir/discussion.json"
      review_pids=()
      for i in "${!review_dirs[@]}"; do team_reply "${review_dirs[$i]}" "${review_wts[$i]}" & review_pids+=("$!"); done
      for i in "${review_pids[@]}"; do wait "$i" || stage_rc=1; done
      for dir in "${review_dirs[@]}"; do team_apply_readonly "$dir" || stage_rc=1; done
    fi
    if [ "${#review_dirs[@]}" -gt 0 ]; then
      T settle-stage "$(team_context_path "${review_dirs[0]}")" >"$team_stage_dir/verdicts.json" 2>>"$RUNLOG" || stage_rc=1
    fi
    for i in "${pids[@]}"; do wait "$i" || stage_rc=1; done
    for dir in "${agent_dirs[@]}"; do
      if ! jq -e '.capabilities | index("review")' "$(team_context_path "$dir")" >/dev/null; then
        team_apply_readonly "$dir" || stage_rc=1
      fi
    done
    for i in "${build_pids[@]}"; do wait "$i" || stage_rc=1; done
    for i in "${!agent_dirs[@]}"; do
      wt="${agent_wts[$i]}"
      gitl -C "$REPO" worktree unlock "$wt" 2>/dev/null || true
      cleanup_worktree "$wt"
    done
    [ "$stage_rc" = 0 ] || rc=1
    model="$old_model" effort="$old_effort"; unset team_context
  done
  finish_approve || rc=1
  if [ "$dry_run" = 1 ]; then
    say "dry run: team prompts written under $RUN_DIR/stages; nothing claimed, no agent started"
  else
    sync_main
    say "done: $RUN_DIR"
  fi
  find "$STATE/runs" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null
  return "$rc"
}
