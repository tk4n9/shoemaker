---
name: shoemaker
description: >-
  Set up, adjust or troubleshoot Shoemaker: scheduled Claude Code agents that keep
  improving a git repository with a human in the loop. On a systemd timer, a
  suggestion agent proposes small specced ideas, the human approves or rejects
  them on a web dashboard (or enables auto approval), and an implementation
  agent builds each approved item in its own worktree and lands it through a
  PR/MR merge gate (GitHub, GitLab
  including self-hosted, or local only). Use this whenever the user wants agents
  to work on a repository on a schedule: "set up shoemaker", "run Claude every
  night on this repo", "agents that propose features I can approve", "an approval
  queue for coding agents", "autonomous PRs on a timer", "cron Claude Code for my
  project". Also use it to change a Shoemaker setup's schedule, model, mode,
  direction, team roles or limits, to upgrade from the nightly-agent skill, or
  to find out why rounds do not build. It does not cover one-off reminders or
  cloud routines.
---

# Shoemaker

> You cut the leather; the elves sew the shoes overnight.

Shoemaker gives a repository scheduled agents and a queue that the human
controls:

```text
systemd timer → shoemaker run: lock, apply waiting notes/team changes, preflight, reconcile merged PRs
   ├─ suggestion agent      (while fewer than max_waiting ideas wait for review)
   │    DIRECTION.md + the code → shoemaker queue add … (spec, prerequisites)
   ├─ the human             approves (with a priority) or rejects, on the dashboard
   ├─ auto-approval agent   (optional, approves eligible waiting ideas with reasons)
   └─ implementation agents (one per approved, ready item, up to max_builds)
        own worktree → branch, tests → shoemaker land (PR, gate) → queue ship
        records → LEDGER.md, runs/<round>/q<item>/summary.md
```

The code is installed once. Each project gets a **state directory** with:

- the human's files: `DIRECTION.md`, `RULES.md`, `shoemaker.conf`;
- the queue database;
- the agents' records;
- their worktrees.

The dashboard's **Team** page starts with the default team: one Suggestion
agent and `max_builds` Implementation agents. Add, edit or remove roles;
saved changes wait for the next round, which interprets and validates them
as ordered stages with `propose`, `review`, `build` or `report` capabilities.
That round uses the new team. Read `<home>/docs/team.md` before helping to
configure one.

On **Direction**, the human's rough notes become goals in `DIRECTION.md`'s
`## Focus` section at the next round. Direction notes are interpreted before
team changes, using the same tool-free interpreter. Read
`<home>/docs/direction.md` before helping to manage notes and goals.

The **Auto approval** switch on Todos is separate from a team's authority
and off by default. Only the dashboard changes it; do not edit `queue.db`
or add a CLI setting to enable it.

You set it up with the `shoemaker` command. You never hand-write harness code.

## 0. Make sure Shoemaker is installed

```sh
command -v shoemaker && shoemaker version
```

If it is missing, install it to a stable place (the systemd units point
there), after telling the user what you will run:

```sh
git clone https://github.com/tk4n9/shoemaker ~/.local/share/shoemaker
(cd ~/.local/share/shoemaker/dashboard && npm ci)
mkdir -p ~/.local/bin && ln -sf ~/.local/share/shoemaker/bin/shoemaker ~/.local/bin/shoemaker
```

Requirements: Linux with systemd user services, git, jq, Node.js 18 or newer,
and Claude Code. Install `gh` for GitHub or `glab` for GitLab.

From here on, `<home>` means the directory `shoemaker version` prints. Its
`docs/` has the references this skill points to.

## The user's decisions, and what you look up

Look these up yourself, with `shoemaker detect <path to repo or umbrella>`:

- the repository, an umbrella workspace around it, the host, the default
  branch;
- CI, the setup and verify commands;
- the repo's own agent docs and landing tooling;
- the tools, the logins, the timezone and linger.

Read every `NOTE:` line. Stop and tell the user if the repo has no commits, or
if `HOST=unknown` (ask which host it is). If `EXISTING_STATE` is set, switch
to *Adjusting* below. If `OLD_HARNESS` is set, see *Migrating* below.

Ask only what is genuinely the user's to decide, in **one** round of
questions, offering the detected defaults:

1. **Focus:** what the agents should work toward. Take free text; offer to
   draft it from the README if they are unsure.
2. **Starting mode:**
   - `suggest`: ideas only, nothing is built;
   - `review`: builds open draft PRs that the user merges;
   - `ship`: builds merge when the gate is green.

   Recommend `review` for the first days, unless the user already knows they
   want `ship`.
3. **Schedule,** in their timezone: nightly (`*-*-* 03:30:00`), a few times a
   day (`*-*-* 04,12,20:30:00`), or hourly (`*-*-* *:30:00`). Mention the
   cost. An idle round (nothing to review or build) starts no agent and costs
   nothing. A build typically costs a few dollars with Opus at high effort.
4. **Off limits:** areas the agents must never change unattended. Suggest
   candidates from the code: auth, payments, migrations, deployment, CI,
   secrets, security-critical paths.

Also ask, when it applies:

- the model and effort, if they want something other than their default;
- **a Git identity**, if the repo has none. It is theirs to choose; never
  invent one.
- **CI**, if the repo has none: whether to set it up now (`<home>/docs/ci.md`).

## Setting up

### 1. Choose the state directory

Use `SUGGESTED_STATE_DIR` from detect:

- `<umbrella>/shoemaker` when the project has an agent workspace outside Git;
- otherwise `<repo>/.shoemaker`, which `init` keeps out of `git status`
  through `.git/info/exclude`.

### 2. Create it

```sh
shoemaker init <state dir> PROJECT=<name> REPO=<repo> HOST=<github|gitlab|none> \
  DEFAULT_BRANCH=<branch> GATE=<ci|local|none> SETUP_CMD="<setup>" VERIFY_CMD="<verify>" \
  [UMBRELLA=<umbrella>] [STATUSLOG=<umbrella>/STATUSLOG.md] [GITLAB_API_HOST=<host/path>]
```

**Choosing the gate:**

- `ci` where CI exists or will be set up;
- `local` only for a repo with no remote, whose user accepts local tests as
  the gate;
- `none` if nothing should merge automatically.

`VERIFY_CMD` must really prove a change works. If there is none, say so, and
keep the mode at `suggest` or `review`.

If detect found the repo's own landing scripts or hooks (`LANDING_SCRIPTS`,
`HOOKS_PATH`), read *Repositories with their own landing tooling* in
`<home>/docs/hosts.md`. Then set `LAND_CMD` and `GUARD_CMD` in
`shoemaker.conf`, and describe their use in `RULES.md`.

### 3. Write DIRECTION.md and RULES.md

- **`DIRECTION.md`:** the front matter (`mode`, `model`, `effort`,
  `approve_model`, `approve_effort`, `apply_model`, `apply_effort`,
  `max_builds`), the *Focus* in the user's words
  made concrete, and any constraints the user gave. The `apply_*` keys
  override only the team interpreter; empty or absent values fall back to
  `model` / `effort`, then the Claude Code default.
  The `approve_*` keys have the same fallback for the optional auto-approval
  agent. `approve_effort` accepts `low`, `medium`, `high`, `xhigh` or `max`.
- **`RULES.md`:**
  - *Off limits*: the user's list;
  - *Before you change code*: the repo's agent docs, and its planned-work
    file if it has one;
  - *Verify*: checks beyond `VERIFY_CMD`;
  - *Conventions*: commit style, docs and tests.

  Keep it short and specific to this repo; the protocols already cover the
  generic rules.

### 4. Prerequisites

Fix each one, or leave it noted for the user:

- **Git identity:** set the one the user chose in the repo's local config.
- **Login:** the user runs `shoemaker --state <dir> login` **in their own
  terminal**, or types `! shoemaker --state <dir> login` here.
  - Never ask for a token in the chat.
  - Explain the token scopes from `<home>/docs/hosts.md`.
  - Then verify with `gh repo view` or `glab api user` inside the repo.
- **CI:** if wanted, follow `<home>/docs/ci.md`: a branch and a PR for the CI
  file. The user approves the merge.

### 5. Check it

```sh
shoemaker --state <dir> doctor
```

It must end with "dry run: …" and a "publish guard: in place" line (unless
`GUARD=0`). Read `runs/<round>-dry/run.log` and fix what it reports. A dry run
claims nothing and never calls the model.

### 6. Schedule and install (ask first)

Installing starts unattended rounds. In `review` or `ship` mode, these push
branches and may merge them. Confirm with the user, then run:

```sh
shoemaker --state <dir> schedule "<OnCalendar spec>" --timezone <Area/City>
shoemaker --state <dir> install        # the timer and the dashboard service
```

Mention the next round time it prints. If detect reported linger off, mention
it: without linger, user timers stop while the user is logged out, and enabling
it needs `sudo loginctl enable-linger`.

### 7. Optionally, ideas now (ask)

Run `shoemaker --state <dir> run --only suggest` in the background. Wait with a
bounded loop until it ends, then point the user to the dashboard.

### 8. Hand over

If the project keeps a status log, append an entry. Then tell the user:

- the dashboard URL, and that its password is in `<dir>/dashboard.json`. Do
  not print the password.
- how to steer: the Direction and Team pages, `DIRECTION.md`, `RULES.md`,
  and the README in the state directory;
- the schedule and the next round;
- what is still pending (login, CI, identity);
- how to pause it (`enabled: false`);
- unless it is installed, that `/plugin install shoemaker-status@shoemaker`
  shows every project's status in Claude Code (a status-line entry and the
  `/shoemaker` pane).

With `GUARD=1`, the runner sets `extensions.worktreeConfig=true` in the repo's
`.git/config`, so the hooks apply to the agents' worktrees only. Mention this
one change to the repository.

## Adjusting

- **Mode, model, effort, limits on counts:** edit the `DIRECTION.md`
  front matter. This takes effect from the next round. An active team's
  total `build` count replaces `max_builds`; all proposers still share
  `max_waiting` and `per_round`.
- **Focus and goals:** use the dashboard's **Direction** page. Notes wait
  for the next real round, which interprets them with the current goals
  and writes a validated goal list into `DIRECTION.md`'s `## Focus`. Notes
  can add, reword, merge or remove goals. Keep a goal by leaving it there;
  **Remove** takes it out immediately, so new work on that topic stops from
  the next round. Existing queue items remain until the human rejects them.
  Waiting notes can be deleted before the round reads them. Direct edits
  to Focus still work; untouched bullets stay verbatim, and an edit made
  while notes are being read takes precedence. A failed interpretation
  preserves Focus and leaves the notes waiting with the reason. Paused
  rounds leave notes waiting; a dry run only reports them.
- **Auto approval:** use the switch in the Todos header. Manual approval is
  the default, and changes take effect next round. The approver runs in
  parallel from round start against the ideas waiting then, using existing
  human and reviewer notes. It approves buildable ideas that fit the focus
  and constraints with Auto priority, or leaves a reason for holding them.
  It never rejects, archives, edits or reprioritises. Returned or restored
  ideas stay with the human; holds are reconsidered only after the spec,
  prerequisites or notes change. Waiting prerequisites must be approved in
  the same result. Ideas added during the round wait for the next approver;
  a later team build stage can use its approvals.
  - `approve_model` and `approve_effort` override only the approver, with
    empty or absent values falling back to `model` / `effort`, then Claude
    Code's default. `--model` / `--effort` apply to it too.
  - `--only approve` runs it alone when enabled. `--only suggest` and
    `--only implement` exclude it. The build `mode` does not affect it;
    `enabled: false` pauses it with the round. A dry run writes its prompt
    when it has work and starts no agents.
  - It uses `SUGGEST_TIMEOUT` and one `MAX_AGENTS` slot. A team that fills
    the cap runs one fewer build, or skips the approver if no build can give
    way. Without a team, suggestion and approval each reserve a slot before
    builds; suggestion takes precedence if only one slot is available. An
    approver with work prevents a round from being idle.
- **Team roles and counts:** use the dashboard's **Team** page. The **Add a
  role** form adds a name, count, description and optional model and effort.
  Use **Edit** and **Remove** on rows in **Active team**; **Undo** and **Undo
  all** cancel waiting changes. Saved edits show old → new on their rows,
  removals are struck through, and added roles appear in **Joining at the
  next round**. Changes are kept in `team/pending.json`.
  Saving starts no agent. At the next real round, after Direction notes,
  the tool-free interpreter returns a config for validation and atomic
  activation before that round's team snapshot. A failed interpretation
  keeps the current team and leaves changes waiting with a reason. A round
  already running keeps its snapshot. Do not hand-write or activate a
  config to bypass the human's saved changes and the runner's validation.
  - The default team has Suggestion ×1 and Implementation × `max_builds`.
    Built-in roles keep `SUGGEST.md` / `IMPLEMENT.md`, their respective
    `propose` / `build` capability and advisory authority. Their descriptions
    add focus to those protocols. Suggestion must keep count 1; add another
    proposing role for more workers. Removing a role removes its agents
    from future rounds. Returning to exactly the default rows removes
    `team/active.json` and restores the standard flow without interpretation.
  - Reviewer authority defaults to `advisory`. Explain any requested
    `filter` (majority rejection screens out an idea) or `approve`
    (unanimous approval permits building) authority before saving it, and
    put the requested authority explicitly in the role's description.
    **Instructions** shows the interpreted role after application; check
    its capabilities and authority on the page. Decisions remain visible
    in the queue with their reasons.
  - Set a role's model and effort with its **Model** and **Effort** controls.
    **Default** inherits from `DIRECTION.md`; `suggest_model` and
    `suggest_effort` apply to the default Suggestion agent and a team's
    built-in Suggestion. Clearing an override restores that inheritance.
    The interpreter must preserve these fields exactly and cannot set them
    from a role's description.
  - Set `apply_model` and `apply_effort` in `DIRECTION.md` to override only
    the shared Team and Direction interpreter. Empty or absent values fall
    back to `model` / `effort`, then the Claude Code default. `apply_effort`
    accepts `low`, `medium`, `high`, `xhigh` or `max`; model values pass
    through as given. `team/last-apply.json` and `direction/last-apply.json`
    record each application's status, model and effort used, or `default`
    when no flag was supplied.
- **Hard limits and conventions:** edit `RULES.md`.
- **Host, gate, commands, timeouts, total agent cap:** edit `shoemaker.conf`.
  `MAX_AGENTS` defaults to 16 when absent, including in older state
  directories after an update. `APPLY_TIMEOUT` limits each Team or Direction
  interpretation and defaults to `5m` when absent. It accepts positive
  integers with `h`, `m` or `s`, or bare seconds, like the worker timeouts.
  Invalid `apply_effort` or `APPLY_TIMEOUT` prevents interpretation from
  starting; the current team or Focus stays unchanged and saved changes
  remain waiting.
- **Schedule:** run `shoemaker schedule "<spec>" --timezone <tz>`. It reloads
  an installed timer. Restarting a timer whose new schedule has just passed a
  slot starts a round at once.
- **"Build this exactly":** the user adds it on the dashboard with **Add &
  approve**.
- **Pause:** `enabled: false`. **Stop:** `shoemaker uninstall`; the state
  directory stays.
- **Update Shoemaker:** run `shoemaker update --check` and show the user the
  new commits and the projects that run this checkout. Then, with their
  go-ahead, run `shoemaker update`. It updates every project on this
  checkout at once, and it refuses while one of their rounds is running. To
  try a version on one project first, follow *Updating* in `<home>/README.md`:
  that project gets a checkout of its own.
  For an existing scheduled project adopting team stages, rerun `schedule`
  with its current expression to regenerate the service timeout. The new
  backstop is `MAX_AGENTS × max(TIMEOUT, SUGGEST_TIMEOUT) + 1h`; update never
  rewrites installed units. Rerun schedule after raising those settings too.

While `systemctl --user is-active <unit>.service` says `activating`, a round
is writing the ledger and the logs. Wait, or append later.

## Troubleshooting

Start with `shoemaker status`, then the round's `run.log`, which names every
decision. `<home>/docs/lessons.md` explains each safeguard and lists symptoms
and their fixes. The usual causes for rounds that build nothing:

- the mode is `suggest`;
- nothing is approved and ready on the dashboard;
- no host login;
- no Git identity.

For interpretation failures, read the latest status on the Team or
Direction page and `team/last-apply.json` or `direction/last-apply.json`.
Each directory's `interpretation-runs/<id>/` holds the prompt and process
output. A timeout, invalid output or failed interpretation leaves the
current team or Focus unchanged; saved changes wait for the next round.
The page refuses mutations while its changes are being applied. Check
`MAX_AGENTS` if a pending or active team is over the cap, and check
`enabled` and the schedule when changes remain waiting without a new round.
`direction/notes.json` retains notes and their outcomes; `direction/goals.json`
records goal provenance and the latest changes. Worker logs are under
`runs/<round>/stages/<stage>/<role>/<agent>/`; each round keeps its starting
config. Custom non-build workers use read-only tools and return structured
results; built-in Suggestion uses the standard `SUGGEST.md` agent and queue
CLI. The runner writes custom workers' reports and applies permitted queue
effects. Multiple reviewers get a parallel first turn and a parallel reply
turn in the same sessions, within the original worker deadline.
Auto-approval records are under `runs/<round>/approve/`: prompt, transcript,
response, applied result and summary. The run log explains when it skips
because the mode is off, nothing is left to examine or no slot is available.

## Migrating from the nightly-agent skill or a hand-made harness

`OLD_HARNESS` points at the old folder.

1. Set up Shoemaker beside it, as above.
2. Carry the old `DIRECTION.md` focus and off-limits over, into `DIRECTION.md`
   and `RULES.md`.
3. Once `doctor` is clean, ask the user before disabling the old timer
   (`systemctl --user disable --now <old unit>.timer`).

Keep the old folder: its `LEDGER.md` is history the suggestion agent can read
if you point `RULES.md` at it.

## Principles

- **Fail closed, so the loop keeps working.** A missing guard, identity or
  login reduces a round to suggestions, never to a half-working publish.
- **Authority is explicit.** By default the human approves on the dashboard.
  Active team reviewers can filter or approve only under their assigned
  authority and the fixed voting rules. The optional auto-approval agent
  uses the same read-only reviewer tools (`--safe-mode --restricted`,
  `Read,Grep,Glob`), guard and worktree. The runner applies structured
  results transactionally only to snapshot ideas still waiting; a human
  decision in the meantime wins. Ordinary agent queue commands cannot
  approve, prioritise, reject or change the auto-approval switch. Direct
  queue database access remains guarded. Reviewer approval does not bypass
  prerequisites, `DIRECTION.md` mode, the guard or the landing gate.
- **Nothing waits without a PR.** Unlanded branches rot while others keep
  merging.
- **The runs are headless.** `claude -p` ends when the agent ends its turn,
  so every wait is in the foreground and bounded (`shoemaker land wait`).
- **Merges are pinned and gated.** The gate merges only the exact commit it
  pushed, and only once the gate is green.
- **Ownership is split.** The human owns `DIRECTION.md`, `RULES.md`,
  `shoemaker.conf`, saved team changes, Direction notes and the installation;
  the runner validates and applies interpreted notes and team changes at
  round start. Worker agents own `LEDGER.md` and their run directories. The
  guard enforces this.
