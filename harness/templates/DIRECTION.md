---
# Read by the runner every round and by the dashboard. Edit freely.
enabled: true    # false: the timer still fires, but the round exits at once
mode: suggest    # suggest | review | ship  (see the README in this folder)
model:           # opus | sonnet | fable | haiku, or a full model id; empty = your Claude Code default
effort:          # low | medium | high | xhigh | max; empty = your Claude Code default
suggest_model:   # the Suggestion agent's model; empty = same as model
suggest_effort:  # the Suggestion agent's effort; empty = same as effort
approve_model:   # the optional auto-approval agent's model; empty = same as model
approve_effort:  # the optional auto-approval agent's effort; empty = same as effort
apply_model:     # the interpreter's model (Team changes, Direction notes); empty = same as model
apply_effort:    # the interpreter's effort; empty = same as effort
max_waiting: 5   # the suggestion agent adds ideas only while fewer than this many wait for your review
per_round: 3     # at most this many new ideas in one round
max_builds: 1    # the default team's parallel builds; a changed team's build counts replace this
---

# Direction

Human-owned. All agents read this file every round; none edits it.
The dashboard's Direction page turns your notes into the Focus bullets at
the start of a round; you can also edit them here. A team changed on the
Team page replaces the default roles and their counts.
Team reviewer authority can screen or approve ideas; mode still limits builds.
Auto approval is off by default; enable it with the switch on the Todos page.

- The **suggestion agent** turns it into ideas in the queue, for you to approve
  or reject on the dashboard, unless a confirmed team has reviewer authority.
- The **implementation agent** builds only approved items, once everything
  the item builds on has shipped.
- The optional **auto-approval agent** approves concrete, buildable ideas
  that fit the focus and constraints, or leaves a reason for holding them.
  It reads existing item notes and cannot reject, edit or reprioritise ideas.

## Focus

- (what the agents should work toward; one or a few lines, in plain words)

## Ideas for the suggestion agent (optional)

<!-- One line each; rough is fine. The suggestion agent turns them into
     specced ideas in the queue. To have something built as you wrote it,
     add it on the dashboard yourself and approve it. -->

## Constraints and preferences

<!-- e.g. "no new dependencies", "keep the current look",
     "prefer tests and docs over new features this week".
     Hard limits that must never bend belong in RULES.md. -->

## Feedback on earlier runs

<!-- React to shipped work, e.g. "#12: good, more like this" or
     "do not touch the settings page again". The reasons you give when you
     reject an idea reach the suggestion agent too. -->

## Human-authorized exceptions (optional)

<!-- A line that starts "Human-authorized exception" lets ONE queue item
     cross named limits of RULES.md or IMPLEMENT.md, for example:
     Human-authorized exception (2026-10-20) for #12: lifts "src/auth/ is off
     limits" for the session-timeout constant and its tests only. -->
