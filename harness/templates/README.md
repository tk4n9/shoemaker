# Shoemaker for __PROJECT__

This folder is Shoemaker's state for __PROJECT__: your steering files, the
queue, the agents' records and their worktrees. The code lives in the Shoemaker
checkout at `__HOME__`; `shoemaker help` lists the commands. Run them from here,
or anywhere with `shoemaker --state __STATE__ …`.

## How a round goes

On each timer tick, `shoemaker run`:

1. marks the queue items whose PR has merged (or closed);
2. starts the **suggestion agent** if fewer than `max_waiting` ideas wait for
   your review. It adds specced ideas to the queue.
3. starts one **implementation agent** per approved, ready item, up to
   `max_builds` side by side. Each builds its item in its own worktree and
   lands it through the merge gate.

With **Auto approval** enabled on Todos, an **auto-approval agent** starts
alongside them on a snapshot of waiting ideas. It approves buildable ideas
that fit `DIRECTION.md`, using Auto priority, and leaves a reason for the
rest. New ideas wait until the next round's approver. Build selection at
round start is unchanged.

A round with nothing to do leaves one line in `runs/idle.log`.

If you confirm a custom team on the dashboard, its stages replace the default
suggestion/build sequence. Stages run in order and agents within a stage run
in parallel. The build roles' total count replaces `max_builds`; the backlog,
per-round idea limit, mode, guard and merge gate still apply.
The auto-approval agent starts alongside the first stage and the round waits
for it. Later build stages can pick up its approvals. It counts toward
`MAX_AGENTS`; a full team gives up one build slot, or skips the approver if
no build can give way. The team's own reviewer authorities stay unchanged.
Without a team, the suggestion and auto-approval agents each reserve a slot
before builds. If the suggestion agent takes the only slot, approval waits
until a later round.

## Your part

- **Review the queue** on the dashboard at <__DASHBOARD_URL__>. The password
  is in `dashboard.json`.
  - Approve ideas with a priority (High, Normal, Low, or Auto, which takes the
    agent's suggestion), or reject them with a reason the suggestion agent
    reads.
  - Add your own ideas in the box at the top. A title alone is enough.
  - **Auto approval** in the Todos header is off by default. A change takes
    effect next round. The approver never rejects or edits items and leaves
    returned or restored ideas for you. Held ideas wait until their spec,
    prerequisites or notes change. Waiting prerequisites must be approved
    in the same result before an item can be approved.
- **Define a team** on the dashboard's **Team** page. Add roles with a name,
  agent count and plain-language description, then **Apply**. This starts an
  interpretation in the background; inspect the proposed stages,
  capabilities, authority and instructions before **Confirm**. **Discard**
  keeps the current team. Applying or a failed interpretation changes
  nothing in the active team.
  - Reviewer authority defaults to `advisory`: notes and verdicts for you to
    decide. `filter` can screen ideas out on a majority rejection, and
    `approve` can approve an idea only with unanimous approval. State the
    authority you want in the description, and check it in the preview.
  - A round reads the team once at its start. Confirming affects following
    rounds, not one already running.
- **Steer** in `DIRECTION.md`. The focus and feedback are in the body; the
  front matter sets each round and the team interpreter:

  | Key | Meaning |
  |---|---|
  | `enabled` | `false` pauses: the timer still fires, but the round exits at once |
  | `mode` | `suggest`: no builds. `review`: builds open draft PRs for you to merge. `ship`: builds merge once the gate is green. Auto approval runs in any mode when enabled |
  | `model`, `effort` | default for all agents and team interpretation; empty means your Claude Code default |
  | `suggest_model`, `suggest_effort` | overrides for the default suggestion agent, when no team is active |
  | `approve_model`, `approve_effort` | overrides for auto approval; empty or absent falls back to `model` / `effort`, then the Claude Code default |
  | `apply_model`, `apply_effort` | overrides for the team interpreter only; empty or absent falls back to `model` / `effort`, then the Claude Code default |
  | `max_waiting`, `per_round` | how many ideas may wait for you, and how many one round adds |
  | `max_builds` | how many approved items are built side by side when no team is active; an active team's build count replaces it |

- **Set hard limits** in `RULES.md`: areas the agents must never change
  unattended, extra checks, and your conventions.
- **Settings** for the host, the gate, the commands and the timeouts are in
  `shoemaker.conf`. `MAX_AGENTS` caps total agents per round; it defaults to
  16 when the key is absent, including after an update. `APPLY_TIMEOUT` limits
  team interpretation and defaults to `5m` when absent. It accepts positive
  integers with `h`, `m` or `s`, or bare seconds, like the worker timeouts.
  Invalid `APPLY_TIMEOUT` or `apply_effort` prevents Apply from starting;
  `apply_effort` accepts `low`, `medium`, `high`, `xhigh` or `max`.
  `approve_effort` accepts the same values and is checked before a round.
  Auto approval uses `SUGGEST_TIMEOUT`. `--model` / `--effort` override its
  settings along with the other agents.

## What to read

| Where | What |
|---|---|
| The dashboard | each item's spec, prerequisites, PR, and a log of every move and who made it |
| `runs/<round>/q<item>/summary.md` | what the implementation agent did, verified, and wants you to decide (next to `proposal.md`, `prompt.md`, `transcript.jsonl`) |
| `runs/<round>/suggest/summary.md` | the ideas added, those dropped, and findings that need you |
| `runs/<round>/approve/` | auto-approval prompt, transcript, response, applied result and summary |
| `team/active.json` | the confirmed team used by subsequent rounds |
| `team/proposed.json` | a validated preview awaiting Confirm or Discard |
| `team/` | instructions embedded in active/proposed configs, interpretation status, model/effort and logs |
| `runs/<round>/team.json` | the config snapshot for that round |
| `runs/<round>/stages/<stage>/<role>/<agent>/` | team worker prompts, transcripts, reports and build summaries; agent numbering starts at 1 |
| `LEDGER.md` | one entry per build |
| `runs/<round>/run.log` | the runner's own log |

## Operating it

```sh
shoemaker status                     # settings, timer, queue, latest rounds
shoemaker team show                  # the confirmed team, or null for the default round
shoemaker doctor                     # a dry run: preflight, guard, decisions, prompts
shoemaker run                        # a round now, in the foreground
shoemaker run --only suggest         # just ask for ideas
shoemaker run --only approve         # just auto approval, when enabled
shoemaker schedule "*-*-* 03:30:00"  # change the schedule (your timezone)
shoemaker login                      # renew the gh/glab login, in your own terminal
shoemaker uninstall                  # stop the timer and the dashboard; this folder stays
journalctl --user -u __UNIT__.service -f   # follow a round started by the timer
```

`--only suggest` and `--only implement` exclude auto approval. A dry run
writes the approver's prompt when it has work and starts no agents. The
auto-approval mode is stored in the queue database's `config` row and is only changed
through the dashboard; agents cannot change it.

After updating an existing scheduled installation for team stages, rerun
`shoemaker schedule` with your existing expression. Its service backstop is
`MAX_AGENTS × max(TIMEOUT, SUGGEST_TIMEOUT) + 1h`; update leaves installed
units unchanged. Rerun schedule after increasing those settings too.
