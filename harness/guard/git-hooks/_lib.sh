# _lib.sh — shared by the git hooks of Shoemaker's worktrees. The runner points
# each agent worktree's core.hooksPath here with a worktree-scoped config (so the
# main checkout and other worktrees keep their own hooks), and tags the worktree
# with shoemaker.state and shoemaker.role. After its own check, every hook hands
# over to the hook the repository itself would have run.

hooks_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
state="${SHOEMAKER_STATE:-$(git config --get shoemaker.state 2>/dev/null)}"
role="$(git config --get shoemaker.role 2>/dev/null || true)"
DEFAULT_BRANCH=""
# shellcheck disable=SC1091
[ -n "$state" ] && [ -f "$state/shoemaker.conf" ] && . "$state/shoemaker.conf"
# Without its settings the guard cannot tell the default branch: refuse, never pass.
[ -n "$DEFAULT_BRANCH" ] || { echo "shoemaker guard: no shoemaker.conf for this worktree (shoemaker.state); refusing." >&2; exit 1; }

# chain <hook-name> [args...]: run the repository's own hook of that name, if any,
# with the same arguments and standard input.
chain() {
  local name="$1"; shift
  local common orig
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  orig="$(git config --file "$common/config" --get core.hooksPath 2>/dev/null || true)"
  if [ -z "$orig" ]; then
    orig="$common/hooks"
  else
    case "$orig" in /*) ;; \~*) orig="$HOME${orig#\~}" ;; *) orig="$(git rev-parse --show-toplevel)/$orig" ;; esac
  fi
  [ "$orig" -ef "$hooks_here" ] && return 0
  if [ -x "$orig/$name" ]; then
    exec "$orig/$name" "$@"
  fi
  return 0
}
