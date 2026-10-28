# Shoemaker

> You cut the leather; the elves sew the shoes overnight.

Shoemaker runs Claude Code agents on your repository on a schedule, with you
in the loop:

1. A **suggestion agent** reads your direction and the code, and proposes
   small, specced ideas.
2. **You** approve the ones you want, with a priority, on a web dashboard, or
   reject them with a reason the agent learns from.
3. An **implementation agent** builds each approved idea in its own git
   worktree, verifies it, and lands it through your pull request gate
   (GitHub, GitLab including self-hosted, or a local-only repository).

By default, you approve every idea before it is built. You can also configure
a team on the dashboard and explicitly give reviewers authority to filter or
approve ideas, or turn on **Auto approval** in the Todos header. Its agent
approves buildable ideas that fit your direction and leaves the rest with a
reason. Nothing reaches your default branch except through the gate.

```text
 systemd timer ─▶ shoemaker run
                   ├─ suggestion agent ──── adds ideas ────▶ ┌───────────────────┐
                   ├─ auto-approval agent (optional) ───────▶ │                   │
                   │                                         │  queue/dashboard  │◀── you: approve,
                   └─ implementation agents ◀─ ready items ──┤                   │    prioritise, reject
                        worktree → tests → PR → gate ──────▶ └───────────────────┘
                        LEDGER.md, runs/<round>/q<item>/summary.md
```

**Status:** early, pre-release (0.1.0-dev). Linux with systemd only for now.

## What you get

- **An approval queue.** It is a small self-hosted web app (Node,
  SQLite, no build step). Ideas arrive with a spec: the problem with
  `file:line` evidence, the change, the files, the tests, the size and risks,
  and a suggested priority. You approve with High, Normal, Low or Auto, or
  reject them. You can add your own ideas: a title is enough. Prerequisites
  are tracked, so an idea that builds on another waits until that one ships.
- **Optional auto approval.** The Todos switch starts a read-only approver
  alongside each round's other agents. It uses Auto priority and records its
  reasons. Held ideas are revisited after their spec, prerequisites or notes
  change; ideas you return to review or restore stay with you. Manual approval
  remains the default.
  The runner reads the switch once at round start; a change takes effect
  next round. Without a team, suggestion and approval each reserve one
  `MAX_AGENTS` slot before builds.
- **Unattended builds you can trust.**
  - Each item is built in a fresh worktree, by a headless `claude -p` agent
    with standing instructions and hard limits.
  - It lands only through the gate: a PR whose CI must pass, or your local
    test command.
  - Several items can be built side by side, but never two that touch the
    same file.
- **Steering in plain files.**
  - `DIRECTION.md`: the focus, the mode (`suggest`, `review` or `ship`), the
    model and the pace.
  - `RULES.md`: your project's hard limits, such as "never touch `src/auth/`".
  - The reasons you give when rejecting ideas reach the suggestion agent.
  - On the dashboard's Direction page, jot down rough notes; the next round
    turns them into goals in `DIRECTION.md`'s Focus. Remove a goal to stop
    work on it.
- **A team you define.** The Team page starts from the default team (one
  suggestion agent, one or more builders). Add roles with a name, count and
  description, or edit and remove them in place. The next round interprets
  the changes into stages, capabilities, authority and instructions, and
  runs with them. Reviewers can discuss ideas before you see them or build
  them, according to the authority you grant.
- **Fail-closed safeguards.** Without a login, a Git identity or a working
  push guard, a round only suggests. Every safeguard answers an incident from
  real use: see [docs/lessons.md](docs/lessons.md).
- **Records.** Each item's log on the dashboard, a `summary.md` per build, an
  append-only `LEDGER.md`, and full transcripts.

## Requirements

- Linux with systemd user services (for the timer)
- [Claude Code](https://claude.com/claude-code), logged in
- git, jq, Node.js 18 or newer
- `gh` for GitHub, or `glab` for GitLab

## Install

### With Claude Code (recommended)

```text
/plugin marketplace add tk4n9/shoemaker
/plugin install shoemaker@shoemaker
```

Then, in your project, ask Claude to "set up shoemaker for this repo". The
skill installs the checkout if needed and inspects the repository. It asks
you four things (focus, mode, schedule, off-limits areas) and then sets
everything up. It asks before turning the timer on.

### By hand

```sh
git clone https://github.com/tk4n9/shoemaker ~/.local/share/shoemaker
(cd ~/.local/share/shoemaker/dashboard && npm ci)
ln -s ~/.local/share/shoemaker/bin/shoemaker ~/.local/bin/shoemaker

shoemaker detect ~/code/my-app            # facts about the repo; read the NOTE lines
shoemaker init ~/code/my-app/.shoemaker PROJECT=my-app REPO="$HOME/code/my-app" \
  HOST=github DEFAULT_BRANCH=main GATE=ci SETUP_CMD="npm ci" VERIFY_CMD="npm test"
cd ~/code/my-app/.shoemaker
$EDITOR DIRECTION.md RULES.md             # the focus, the mode, the hard limits
shoemaker login                           # gh or glab, in your own terminal
shoemaker doctor                          # a dry run: preflight, guard, decisions
shoemaker schedule "*-*-* 03:30:00"       # nightly, in your timezone
shoemaker install                         # the timer, and the dashboard on 127.0.0.1
```

`shoemaker init` prints the dashboard's address. Its password is in
`dashboard.json` in the state directory.

## Updating

The code is installed once per machine. A project holds only its state
directory, and its systemd units run the checkout that wrote them. So you
update the checkout, not the projects:

```sh
shoemaker update --check     # the new commits, and the projects that run this checkout
shoemaker update             # fast-forward, npm ci if the lockfile changed, restart their dashboards
```

`update` refuses while a round of one of those projects is running, and
holds their round locks while it works. A round that comes due during the
update skips, as it would for an overlap. Each project's next round runs the
new code. State directories are never changed: `DIRECTION.md`, `RULES.md`,
`shoemaker.conf`, the queue and the records stay as they are. The queue's
schema migrates itself on first use.

For an existing scheduled project that will use team stages, rerun
`shoemaker schedule "<existing calendar expression>"` after updating. This
regenerates the round timeout for sequential stages; `update` does not
rewrite installed unit files. The new backstop is
`MAX_AGENTS × max(TIMEOUT, SUGGEST_TIMEOUT) + 1h`. Rerun schedule after
increasing the cap or worker timeouts as well.

The Claude Code plugin (the setup skill) is updated separately, through
`/plugin` or `claude plugin update shoemaker@shoemaker`.

**One project at a time.** To try a new version on one project first, give
it a checkout of its own, then point that project's units at it:

```sh
git clone https://github.com/tk4n9/shoemaker ~/.local/share/shoemaker-next
(cd ~/.local/share/shoemaker-next/dashboard && npm ci)
~/.local/share/shoemaker-next/bin/shoemaker --state "<state-dir>" schedule "<spec>"
~/.local/share/shoemaker-next/bin/shoemaker --state "<state-dir>" install
```

The rounds and the dashboard then run that checkout. The `shoemaker` on your
PATH is still the main one, so call the second checkout's `shoemaker` by its
path for that project. `shoemaker status` names the checkout a project's
units run. `update` in a checkout restarts only the projects that run it. To
move the project back, run `schedule` and `install` again with the main
checkout's `shoemaker`.

## How a round works

On each tick of the timer:

1. **Take in your changes.** Notes waiting on the Direction page become
   goals in `DIRECTION.md`, and waiting Team page changes become the team.
   If either fails, it keeps waiting and the round goes on.
2. **Reconcile.** Items whose PR merged are marked shipped; items whose PR
   was closed are marked failed.
3. **Suggest.** If fewer than `max_waiting` ideas wait for your review, the
   suggestion agent adds up to `per_round` more, in a read-only checkout.
   When enabled, auto approval starts alongside the other agents, using the
   ideas waiting at round start. Ideas added during the round wait for the
   next approver. Existing build selections are unchanged.
4. **Build.** For each approved item whose prerequisites have shipped (up to
   `max_builds`), an implementation agent runs in its own worktree:
   1. It checks the spec against the code and writes a proposal.
   2. It implements and verifies the change.
   3. It opens a PR with `shoemaker land`, and in `ship` mode waits for the
      gate and merges.
   4. It records the result in the queue, the ledger and `summary.md`.

   An item left unfinished is resumed next round; after three rounds it fails
   with a reason, for you.
5. **Idle.** With nothing to suggest, approve or build, no agent starts and
   the round costs nothing.

The dashboard says, at the top, what the next round will build, or why it
will build nothing.

## Teams

Without configuration, the **Team** page shows the default team: Suggestion
×1 and Implementation × `max_builds`, which is exactly the round above. Add
a role with the form at the top, for example three feature suggestion
agents, two feature reviewers who discuss whether ideas are worth building,
or a reporter. Edit or remove a role on its row in **Active team**. Say
explicitly if a reviewer may filter out ideas or approve them for building;
the default is advisory, so you still decide.

Changes wait, marked on their rows, until the next round starts. Then a
Claude Code session with no tools interprets the descriptions into ordered
stages and role instructions, Shoemaker validates the result, and that round
runs with the new team. **Instructions** on each row shows what its agent
was told. If the interpretation fails, the round runs the current team and
the changes keep waiting, with the reason. Suggestion and Implementation
keep `SUGGEST.md` and `IMPLEMENT.md` in any team; their descriptions add a
focus.

Each round reads the active team once. Its stages run in order, with agents
in each stage running in parallel. The fixed capabilities are `propose`,
`review`, `build` and `report`; a role's description cannot grant other
operations. The total build count replaces `max_builds`, while `max_waiting`
and `per_round` apply to all proposers together. `MAX_AGENTS` in
`shoemaker.conf` caps total agents per round (16 when absent). `DIRECTION.md`
still controls pausing, the build mode and default model/effort.

Auto approval runs alongside the first stage and finishes before the round
ends. Later build stages can use its approvals. It counts as one agent: a
full roster gives up one build slot, or the approver skips that round if no
build can give way. Team review authorities and voting rules are unchanged.

See [docs/team.md](docs/team.md) for the config, reviewer rules and records,
and [docs/direction.md](docs/direction.md) for the Direction page.

## Modes

| Mode | Suggestion agent | Implementation agent |
|---|---|---|
| `suggest` | adds ideas | does not run |
| `review` | adds ideas | opens a **draft** PR for each approved item; you merge it |
| `ship` | adds ideas | merges once the gate is green; opens a draft instead when the agent judges the change not ready for an unattended merge |

These build limits also apply to custom teams: a `build` role never runs in
`suggest` mode, and reviewer approval does not bypass the PR or merge gate.
Auto approval is independent of `mode`; `enabled: false` pauses it with the
rest of the round. `--only approve` runs it alone, while `--only suggest`
and `--only implement` exclude it. `approve_model` and `approve_effort` in
`DIRECTION.md` fall back to `model` and `effort`, then the Claude Code
default; `--model` and `--effort` override them. Its timeout is
`SUGGEST_TIMEOUT`.

The gate (`GATE` in `shoemaker.conf`) decides what must pass:

- `ci`: the PR's checks;
- `local`: your `VERIFY_CMD`, for repos with no remote;
- `none`: never merge automatically.

## Safety model

Shoemaker runs agents unattended with your user's permissions. Read this
before you turn on `ship`.

- **Approval.** Human approval, priority changes and rejection stay on the
  dashboard. A team's reviewers can record scoped verdicts; the runner
  applies only the filtering or approval authority shown on the Team page. The default-off Todos switch can separately enable auto approval;
  agents cannot change it. The approver has only `Read`, `Grep` and `Glob`
  with `--safe-mode --restricted`, the guard and a worktree. The runner
  applies its structured results transactionally, only to snapshot items
  still waiting; a human decision wins. Waiting prerequisites must be
  approved in the same result. It never rejects, edits or reprioritises.
  Ordinary agent queue commands cannot grant approval or change the switch.
- **The publish guard.**
  - Each agent worktree gets git hooks that refuse commits on the default
    branch, pushes to it, and any commit by the suggestion agent.
  - A Claude Code `PreToolUse` hook blocks bypasses: `--no-verify`, merges
    outside the gate, edits to your steering files, reading credentials.
  - The round refuses to start an agent when the guard is not in place.
- **The gate pins merges.** `shoemaker land` merges only the exact commit it
  pushed, and only once checks pass. It never relies on `gh pr merge --auto`,
  which merges at once on a repository without required checks.
- **Limits are instructions plus hooks, not a sandbox.** The agents run with
  `--permission-mode bypassPermissions` by default, with your SSH keys and
  network.
  - The real boundary is your host's branch protection, which requires CI on
    the default branch.
  - Start with `review` mode.
- **The dashboard** listens on `127.0.0.1` with a generated password, and
  accepts changes only from its own page. Approving an item lets an agent
  build it, so do not expose the dashboard to an untrusted network.

## Documentation

- [docs/queue.md](docs/queue.md): the queue's statuses, build order, and the
  CLI contract the agents use
- [docs/team.md](docs/team.md): defining a team, its authority, stages and
  records
- [docs/direction.md](docs/direction.md): steering the Focus with notes on
  the Direction page
- [docs/hosts.md](docs/hosts.md): GitHub, GitLab and local-only setups,
  logins, and host settings
- [docs/ci.md](docs/ci.md): setting up CI as the merge gate
- [docs/lessons.md](docs/lessons.md): why each safeguard exists, and
  troubleshooting by symptom
- [harness/SUGGEST.md](harness/SUGGEST.md) and
  [harness/IMPLEMENT.md](harness/IMPLEMENT.md), plus
  [harness/APPROVE.md](harness/APPROVE.md): the agents' standing
  instructions
- [dashboard/README.md](dashboard/README.md): developing the dashboard

## Repository layout

```text
bin/shoemaker        the command: detect, init, schedule, install, run, doctor, status, queue, team, dashboard, land, login, update
harness/             the runner (run.sh), the merge gate (land.sh), the guard, protocols, templates
dashboard/           the queue's web app and its CLI (Node ≥ 18, better-sqlite3)
plugin/              the Claude Code plugin: the setup skill
docs/                user documentation
test/                end-to-end self-test with stand-ins for claude, gh and glab
```

## License

Not chosen yet.
