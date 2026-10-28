#!/usr/bin/env bash
# claude-guard.sh <state dir> — PreToolUse hook for Shoemaker's agents. The runner
# wires it with `claude --settings <state>/guard/claude-settings.json`. It blocks
# the plain-text ways around the merge gate, the queue and the harness. The git
# hooks in git-hooks/ check the refs actually pushed; this layer catches what
# they cannot see. Exit 2 blocks the call and shows stderr to the agent.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOME_DIR="$(cd "$here/../.." && pwd -P)"          # the Shoemaker checkout
STATE="$(cd "${1:-${SHOEMAKER_STATE:-}}" 2>/dev/null && pwd -P)" \
  || { echo "shoemaker guard: no state directory given; refusing." >&2; exit 2; }
# shellcheck disable=SC1091
. "$STATE/shoemaker.conf" || { echo "shoemaker guard: cannot read $STATE/shoemaker.conf; refusing." >&2; exit 2; }
D="${DEFAULT_BRANCH:-main}"
# When Shoemaker works on its own checkout, that checkout is the repository: the
# merge gate protects it, and the agents' worktrees live inside it.
[ "$HOME_DIR" -ef "${REPO:-/nonexistent}" ] && HOME_DIR="/nonexistent/shoemaker-home"

block() { echo "shoemaker guard: $*" >&2; exit 2; }

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
    # Normalize, so runs/../DIRECTION.md cannot pass as runs/* (STATE is physical too).
    [ -n "$path" ] && path="$(realpath -m -- "$path" 2>/dev/null || printf '%s' "$path")"
    case "$path" in
      "$STATE"/worktrees/*/.git|"$STATE"/worktrees/*/.git/*) block "a worktree's .git link is managed by the runner; do not change it." ;;
      # The agents' own worktrees live in the state directory, and are theirs to edit.
      "$STATE"/LEDGER.md|"$STATE"/runs/*|"$STATE"/worktrees/*) exit 0 ;;
      "$STATE"/*) block "$path is the human's; you may write only LEDGER.md and your run directory. Put suggestions in summary.md." ;;
      "$HOME_DIR"/*) block "the Shoemaker installation ($HOME_DIR) is not yours to change. Put suggestions in summary.md." ;;
    esac
    exit 0 ;;
  Bash) ;;
  *) exit 0 ;;
esac

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
[ -n "$cmd" ] || exit 0

# Hooks bypass and hook redirection.
case "$cmd" in
  *--no-verify*) block "--no-verify skips the git hooks that keep you off $D. Publish with shoemaker land." ;;
  *core.hooksPath*|*extensions.worktreeConfig*|*shoemaker.state*|*shoemaker.role*|*shoemaker.teamContext*) block "the hook configuration is managed by the runner; do not change it." ;;
  *sudo\ *|sudo) block "no sudo or root in an unattended run." ;;
esac
# commit -n is --no-verify; look only outside quoted text (a message may say "-n").
unquoted="$(printf '%s' "$cmd" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")"
if printf '%s' "$unquoted" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit([[:space:]]+[^[:space:]]+)*[[:space:]]+-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)'; then
  block "git commit -n skips the hooks. Commit without it."
fi

# Pushes that touch the default branch, or every branch.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push([[:space:]]|$)'; then
  push_args="$(printf '%s' "$cmd" | sed -E 's/.*[[:space:]]push([[:space:]]|$)//')"
  for tok in $push_args; do
    tok="${tok#+}"; tok="${tok%\"}"; tok="${tok#\"}"
    case "$tok" in
      --all|--mirror|--delete|-d|--prune) block "git push $tok can update or delete $D or many branches. Push only your build branch, through shoemaker land." ;;
      "$D"|*:"$D"|*:refs/heads/"$D"|refs/heads/"$D") block "pushing to $D is the merge gate's job. Publish with shoemaker land." ;;
    esac
  done
fi

# Merges and default-branch moves outside the gate.
if printf '%s' "$cmd" | grep -Eq '(gh[[:space:]]+pr[[:space:]]+merge|glab[[:space:]]+mr[[:space:]]+merge|merge_requests/[^[:space:]]*/merge|pulls/[0-9]+/merge)'; then
  block "merge only through shoemaker land (it pins the commit and checks the gate)."
fi
if printf '%s' "$cmd" | grep -Eq "(update-ref[[:space:]]+refs/heads/$D([[:space:]]|$)|branch[[:space:]]+(-f|--force)[[:space:]]+$D([[:space:]]|$)|checkout[[:space:]]+-B[[:space:]]+$D([[:space:]]|$)|switch[[:space:]]+-C[[:space:]]+$D([[:space:]]|$))"; then
  block "moving $D by hand bypasses the gate."
fi

# Credentials, including the dashboard's password.
if printf '%s' "$cmd" | grep -Eq '(gh[[:space:]]+auth[[:space:]]+token|--show-token|glab[[:space:]]+config[[:space:]]+get[[:space:]]+token|\.ssh/|glab-cli/config\.yml|gh/hosts\.yml|\.credentials\.json|dashboard\.json)'; then
  block "do not read or print credentials."
fi

# The queue: only through `shoemaker queue`, which logs who did what.
case "$cmd" in
  *queue.db*) block "use shoemaker queue; never open queue.db directly." ;;
esac

# Writes to the harness or the installation through the shell (reading is fine).
writes='(>|sed[[:space:]]+-i|perl[[:space:]]+-i|[[:space:]]tee[[:space:]]|(^|[[:space:]])(mv|cp|rm|truncate|chmod|ln)[[:space:]])'
for f in shoemaker.conf DIRECTION.md RULES.md guard systemd team direction; do
  case "$cmd" in
    *"$STATE/$f"*) printf '%s' "$cmd" | grep -Eq "$writes" && block "$f is the human's; put suggestions in summary.md." ;;
  esac
done
case "$cmd" in
  *"$HOME_DIR"/*) printf '%s' "$cmd" | grep -Eq "$writes" && block "the Shoemaker installation is not yours to change; put suggestions in summary.md." ;;
esac
exit 0
