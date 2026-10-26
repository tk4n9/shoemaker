# Why each safeguard exists, and troubleshooting

Shoemaker was first built by hand for one real project and run hourly for
weeks, then generalized. Every safeguard below answers something that actually
went wrong there. Read the matching section when a run
misbehaves, or before you loosen a safeguard.

## Contents
1. Safeguards and the incidents behind them
2. Troubleshooting by symptom
3. Operating habits

## 1. Safeguards and the incidents behind them

| Safeguard | Incident |
|---|---|
| the runner refuses to start unless the push guard is really in place | A refactor moved the repo's git hooks, and `core.hooksPath` kept pointing at the old, now empty, folder. Nothing failed: the guard against pushing to the default branch was silently off. |
| No Git identity: the round runs only the suggestion agent | The first run spent 31 minutes building and testing a good change, then could not commit it. |
| No host login: the round runs only the suggestion agent; no branch is ever left without a PR | Without a login the runs pushed branches with no MR. Collaborators merged over 200 commits in the meantime, and the human had to resolve the conflicts by hand. |
| *This is a headless run* (IMPLEMENT.md): wait in the foreground, in bounded steps | An agent started its wait for the pipeline in the background and ended its turn "to be notified". In `claude -p`, ending the turn ends the process, so the run stopped. The MR merged anyway, but nothing was recorded. |
| the runner resumes an unrecorded session once | The backstop for the same failure. |
| `shoemaker land` never uses `gh pr merge --auto`; it merges itself, pinned to the pushed SHA | On a repository without required checks, `--auto` merges at once, which would bypass CI. |
| `shoemaker land` resolves a rebase conflict by refusing, naming the files, and leaving the branch as it was | This lets the agent, which knows the change, do the merge. A half-rebased tree is never left behind. |
| The agent may write only `LEDGER.md` and its run directory; the Claude guard blocks edits to the harness | An agent that can edit the runner, `IMPLEMENT.md` or its gate can remove its own limits. |
| Tokens are stored in the CLI's config file (`--insecure-storage`) | Newer gh and glab default to the desktop keyring, which a systemd service cannot unlock at 03:30. Runs then fail as if logged out. |
| GitLab login uses a legacy token with `api` and `write_repository` | A fine-grained token lacked `User: Read`, which every glab command checks first (403 `insufficient_granular_scope`). |
| the runner warns 14 days before the token expires | A lapsed token silently turns every run into a proposal. |
| The timer is pinned to a timezone, with no random delay | "Run at 04:30" means 04:30 local time, regardless of the system timezone. A random delay made the timer show 04:38, which looked like a bug. |
| `Persistent=false` | A missed slot (laptop asleep) should not start a run in the middle of the working day. |
| Run ids get a suffix when one is taken | Two runs in the same minute shared an id, and the second seemed to have already recorded itself. |
| Worktrees live in the state directory, excluded from `git status` | A worktree nested in the main checkout shows up as untracked in the human's `git status`. |
| Approving, prioritising and rejecting exist only on the dashboard; the queue CLI has no command for them | The agents use the CLI. An agent that could approve its own ideas would remove the human from the loop. |
| The suggestion agent adds ideas only while fewer than `max_waiting` wait for review | Hourly rounds filled the review list faster than a person reads it. |
| Two items whose specs name the same file are never built side by side | Parallel builds that touch one file conflict at merge time, and one of them redoes its work. |
| An agent that exits at once, with no turns, gives its attempt back | A usage limit once ended seven rounds in a row at once; counting them as attempts would have failed good items. |
| An item that a round leaves unfinished is resumed first; after 3 rounds it fails, for the human | A stuck item must not block the queue forever, nor be retried silently. |
| The runner marks an item shipped when its PR merges, even after the item failed | Items built on it would otherwise wait forever for a merge that already happened. |
| An idle round leaves one line in `runs/idle.log`, not a run directory | Hourly idle rounds buried the useful run directories. |
| One change per run, about 400 lines or fewer, and "no-op" is a good outcome | An unattended agent that has to produce something produces churn. |

## 2. Troubleshooting by symptom

**Rounds never build anything ("implementation agent: not this round").**

1. Read `runs/<round>/run.log` (or `runs/idle.log` for idle rounds). It names
   the cause: no identity, no login, no access to the repository, mode
   `suggest`, or nothing approved and ready on the dashboard.
2. Check the login:
   - GitHub: `gh repo view` inside the repository;
   - GitLab: `glab api user` inside the repository.
3. If the login is missing or expired, the user runs `shoemaker login` in
   their own terminal.

**glab prints `ERROR: parsing time "…" as "2006-01-02T15:04:05Z07:00"`.**
An older glab is reading a config written by a newer one.

1. Compare the binaries: `type -ap glab | xargs -n1 readlink -f | sort -u`,
   then run `--version` on each.
2. Put the newest one first on `PATH`.
3. Fix the field in `~/.config/glab-cli/config.yml` without printing the
   token: `last_update_check_timestamp: 2026-05-06T10:14:49+09:00`, with a
   `T` instead of the space.
4. Optionally set `check_update: false`.

**glab: "None of the git remotes … point to a known GitLab host".**
glab picks the host from the remote's SSH host, and that host has no entry.
Log in with `--hostname <ssh host> --api-host <web host>/<path>`. The helper
does this using `GITLAB_API_HOST`.

**GitHub PRs never merge, and `shoemaker land wait` keeps exiting 5 with "no checks
reported".** The workflow does not run on `pull_request`. Add that trigger
([ci.md](ci.md)).

**A run is recorded as `crashed`.**

1. Read `runs/<round>/stderr.log` and the end of `transcript.jsonl`. A clean
   exit with no ledger entry means the agent ended its turn early. The
   resume should have caught that, so check `run.log` for "resuming".
2. Check the host for an open `shoemaker/*` PR. It may have merged anyway; the
   next round notices and marks the item shipped.
3. Add a correction entry to the ledger.

**An item keeps failing, or sits in progress.** Open it on the dashboard: its
log says what each attempt did, and `runs/<round>/q<item>/summary.md` says why.
Edit the spec to answer the agent's question, then **Retry**; or reject it.
If you took the work over yourself, mark it shipped from its menu.

**A CI failure in code the change did not touch.** It is probably a flaky
test. The agent retries once, then treats a second failure as real. If the
same test keeps failing, record it for the human; never weaken it.

**Tests fail only around local midnight.** Some suites are date-sensitive
("Yesterday" against "Today"). Run them with `TZ=UTC`, as CI often does, and
note the flakiness in the summary.

**The timer started a run right after you changed the schedule.** Restarting a
timer whose new schedule has just passed a slot fires it once. Either let that
run finish, or stop it with `systemctl --user stop <unit>.service`.

## 3. Operating habits

- **While a run is active,** check `systemctl --user is-active <unit>.service`.
  While it says `activating`, do not edit `LEDGER.md`, and do not edit the
  status log the agent appends to. Two writers can lose an entry.
- **To have something built as you wrote it,** add it on the dashboard and
  approve it (**Add & approve**). A title alone is enough. To steer the ideas
  instead, write it in `DIRECTION.md`.
- **Cost:**
  - each agent reports its cost in `run.log`;
  - with Opus at high effort, a build costs a few dollars, and hourly rounds
    multiply that (an idle round starts no agent and costs nothing);
  - lower `effort`, use `model: sonnet`, or schedule less often.
- **To update,** run `shoemaker update`. It updates the checkout, runs
  `npm ci` if the lockfile changed, and restarts the dashboards of the
  projects that run that checkout. It refuses while one of their rounds is
  running, so a round never mixes old and new code. State directories are
  never touched.
