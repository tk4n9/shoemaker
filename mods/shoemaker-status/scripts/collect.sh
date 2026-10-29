#!/usr/bin/env bash
# collect.sh [CWD]: one JSON object, {offset, projects}, describing every
# Shoemaker project on this machine, read-only. A project is found by its installed round unit
# (~/.config/systemd/user/*.service running `shoemaker --state DIR run`), or
# by a state directory at or above CWD, the way `shoemaker` itself finds one.
set -uo pipefail
cwd="${1:-$PWD}"
units_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

declare -A seen=()
states=() homes=()

add() {  # add STATE HOME
  local s
  s="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  [ -f "$s/shoemaker.conf" ] || return 0
  [ -n "${seen[$s]:-}" ] && return 0
  seen[$s]=1; states+=("$s"); homes+=("$2")
}

for f in "$units_dir"/*.service; do
  [ -e "$f" ] || continue
  line="$(grep -m1 -E '^ExecStart="[^"]*/bin/shoemaker" --state "[^"]*" run$' "$f" 2>/dev/null)" || continue
  home="${line#ExecStart=\"}"; home="${home%%/bin/shoemaker\"*}"
  state="${line#*--state \"}"; state="${state%\" run}"
  add "$state" "$home"
done

# A project set up but not installed is still shown while you work in it.
default_home=""
if p="$(command -v shoemaker 2>/dev/null)"; then
  default_home="$(cd "$(dirname "$(readlink -f "$p")")/.." 2>/dev/null && pwd -P)"
fi
d="$cwd"
while [ -n "$d" ]; do
  if [ -f "$d/shoemaker.conf" ]; then add "$d" "$default_home"; break; fi
  if [ -f "$d/.shoemaker/shoemaker.conf" ]; then add "$d/.shoemaker" "$default_home"; break; fi
  if [ -f "$d/shoemaker/shoemaker.conf" ]; then add "$d/shoemaker" "$default_home"; break; fi
  [ "$d" = / ] && break
  d="$(dirname "$d")"
done

conf() {  # conf FILE KEY: a value of shoemaker.conf, quoted or bare, without sourcing it
  sed -nE "s/^$2=(\"([^\"]*)\"|([^[:space:]#]*)).*/\2\3/p" "$1" | head -n 1
}
front() {  # front FILE KEY: a value of DIRECTION.md's front matter
  awk -v k="$2" 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{exit}
    NR>1 { sub(/#.*/, ""); if ($1 == k":") { $1=""; gsub(/^ +| +$/, ""); print; exit } }' "$1" 2>/dev/null
}
unit_show() {  # unit_show UNIT PROP...: a JSON object of the properties, timestamps as unix seconds
  local u="$1"; shift
  local args=() p
  for p in "$@"; do args+=(-p "$p"); done
  systemctl --user show "$u" "${args[@]}" --timestamp=unix 2>/dev/null \
    | jq -R -s 'split("\n") | map(select(length > 0) | capture("^(?<k>[^=]+)=(?<v>.*)$"))
                | map({(.k): (if (.v | test("^@[0-9]+$")) then (.v[1:] | tonumber) else .v end)}) | add // {}'
}
installed() { [ -e "$units_dir/$1" ]; }

out="[]"
for i in "${!states[@]}"; do
  S="${states[$i]}"; HOME_DIR="${homes[$i]}"
  C="$S/shoemaker.conf"; D="$S/DIRECTION.md"
  unit="$(conf "$C" UNIT)"

  timer='null'; round='null'; dash='null'
  if [ -n "$unit" ] && installed "$unit.timer"; then
    timer="$(unit_show "$unit.timer" ActiveState NextElapseUSecRealtime LastTriggerUSec)"
    round="$(unit_show "$unit.service" ActiveState SubState ExecMainStartTimestamp ExecMainExitTimestamp Result)"
  fi
  if [ -n "$unit" ] && installed "$unit-dashboard.service"; then
    dash="$(unit_show "$unit-dashboard.service" ActiveState)"
  fi

  stats='null'; items='[]'; approval='null'; rev=''; behind=0
  if [ -n "$HOME_DIR" ] && [ -f "$HOME_DIR/dashboard/bin/queue.mjs" ] && command -v node >/dev/null; then
    Q="$HOME_DIR/dashboard/bin/queue.mjs"
    stats="$(SHOEMAKER_STATE="$S" timeout 10 node "$Q" stats --json 2>/dev/null | jq -c . 2>/dev/null)" || stats='null'
    [ -n "$stats" ] || stats='null'
    items="$(SHOEMAKER_STATE="$S" timeout 10 node "$Q" list --status in_progress,review,failed --json 2>/dev/null \
      | jq -c '[.[] | {id, title, status, pr_url, attempts, status_note, last_run}]' 2>/dev/null)" || items='[]'
    [ -n "$items" ] || items='[]'
    approval="$(SHOEMAKER_STATE="$S" timeout 10 node "$Q" approval --json 2>/dev/null | jq -c '.enabled' 2>/dev/null)" || approval='null'
    [ -n "$approval" ] || approval='null'
  fi
  if [ -n "$HOME_DIR" ] && [ "$(git -C "$HOME_DIR" rev-parse --show-toplevel 2>/dev/null)" = "$HOME_DIR" ]; then
    rev="$(git -C "$HOME_DIR" rev-parse --short HEAD 2>/dev/null)"
    behind="$(git -C "$HOME_DIR" rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)"
  fi

  # The newest rounds, each with its last log line; the newest with its tail too.
  rounds="$(find "$S/runs" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort | tail -n 5 \
    | while read -r r; do
        printf '%s\t%s\n' "$r" "$(tail -n 1 "$S/runs/$r/run.log" 2>/dev/null | sed 's/^.*\]: //')"
      done | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {id: .[0], last: (.[1] // "")})')"
  latest="$(find "$S/runs" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
  tail_lines='[]'
  if [ -n "$latest" ] && [ -f "$S/runs/$latest/run.log" ]; then
    tail_lines="$(tail -n 4 "$S/runs/$latest/run.log" | sed 's/^.*\]: //' | jq -R -s -c 'split("\n") | map(select(length > 0))')"
  fi
  idle=0; [ -f "$S/runs/idle.log" ] && idle="$(wc -l <"$S/runs/idle.log" | tr -d ' ')"

  out="$(jq -c \
    --arg state "$S" --arg home "$HOME_DIR" --arg rev "$rev" --argjson behind "${behind:-0}" \
    --arg project "$(conf "$C" PROJECT)" --arg repo "$(conf "$C" REPO)" --arg umbrella "$(conf "$C" UMBRELLA)" \
    --arg host "$(conf "$C" HOST)" --arg branch "$(conf "$C" DEFAULT_BRANCH)" --arg gate "$(conf "$C" GATE)" \
    --arg url "$(conf "$C" DASHBOARD_URL)" --arg unit "$unit" \
    --arg enabled "$(front "$D" enabled)" --arg mode "$(front "$D" mode)" --arg model "$(front "$D" model)" \
    --arg effort "$(front "$D" effort)" --arg max_builds "$(front "$D" max_builds)" \
    --argjson timer "$timer" --argjson round "$round" --argjson dash "$dash" \
    --argjson stats "$stats" --argjson items "$items" --argjson autoApproval "$approval" \
    --argjson rounds "${rounds:-[]}" --arg latest "$latest" --argjson tail "$tail_lines" --argjson idle "${idle:-0}" \
    '. + [{
      state: $state, home: $home, rev: $rev, behind: $behind,
      project: $project, repo: $repo, umbrella: $umbrella, host: $host, branch: $branch, gate: $gate,
      dashboardUrl: $url, unit: $unit,
      direction: {enabled: $enabled, mode: $mode, model: $model, effort: $effort, maxBuilds: $max_builds},
      timer: $timer, round: $round, dashboard: $dash,
      stats: $stats, items: $items, autoApproval: $autoApproval,
      rounds: $rounds, latest: $latest, tail: $tail, idle: $idle
    }]' <<<"$out")"
done
# The host's UTC offset too, so times read as on the systemd timer's clock.
jq -c -n --arg offset "$(date +%z)" --argjson projects "$out" '{offset: $offset, projects: $projects}'
