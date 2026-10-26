# The queue

The dashboard's Todos page is a queue between the agents and you. By default, a
**suggestion agent** adds ideas, **you** approve or reject them, and an
**implementation agent** builds what you approved: one item per build, and
several builds side by side when their files don't overlap. This page is the
contract that the agents, and the runner that starts them, rely on.

A confirmed [team](team.md) can add review stages before implementation.
Reviewers leave notes and verdicts on the same queue items; only the authority
you confirmed can let those verdicts change an item's status.
The **Auto approval** switch in the Todos header separately enables an
approver alongside the round's other agents. It is off by default.

```text
suggestion agent ─ add ─▶ waiting for review ─ human / enabled approver / team ─▶ approved
                                     │                                                  │
                                     └─ you reject ─▶ archived ◀─ restore ─┐            │ every prerequisite shipped
                                                                           │            ▼
implementation agent ◀──────────────────────────── pick (up to N per round) ready
        │
        ├─▶ shipped                 (merged)
        ├─▶ waiting for your merge  (a draft pull request for you)
        └─▶ failed                  (with the reason; you retry or reject)
```

## Where the queue lives

Each managed project has a Shoemaker state directory. The queue is the SQLite
file `queue.db` in it, and the dashboard's settings are `dashboard.json`.
The auto-approval mode is stored in `queue.db`'s `config` row, migrated with
a default of off. Only the dashboard's `POST /config` changes it. The runner
reads it once at round start, so a mid-round flip affects the next round.

| Variable | Effect |
|---|---|
| `SHOEMAKER_STATE` | The state directory: `$SHOEMAKER_STATE/queue.db` and `$SHOEMAKER_STATE/dashboard.json` |
| `SHOEMAKER_DB` | Overrides the database file (tests) |
| `SHOEMAKER_DASHBOARD_CONFIG` | Overrides the dashboard config file (tests) |
| `SHOEMAKER_AUTHOR` | Who writes the CLI's log entries (default `agent`); `--by` overrides it |

With none of them set, a development checkout uses `dashboard/data/queue.db`
and `dashboard/config.json`.

`dashboard.json` keys: `host` (default `127.0.0.1`), `port` (default `6531`),
`password` (empty disables sign-in, with a warning), `secret` (signs the
sign-in cookie), `base_path` (serve under a subpath behind a reverse proxy),
and `project` (names the project while the queue still has the default name).
The optional `target_dir` (the managed repository's path) is shown on the
Dashboard page.

## Items

An item is a todo: a title, a spec (the markdown "explanation"), a priority,
its prerequisites, and a log. The log records every move, with who made it.

| Status | Meaning | Who moves it on |
|---|---|---|
| `proposed` | Waiting for review | You, the enabled auto-approval agent, or a team review stage with confirmed authority |
| `approved` | In the queue, with a priority | The implementation agent, once it is ready |
| `in_progress` | Picked up by a round | The implementation agent |
| `review` | A draft pull request waits for your merge | Whoever sees the merge: the agent, the runner or you |
| `shipped` | Merged | Nobody: it is done |
| `failed` | The agent could not finish; the reason is shown | You: retry or reject |
| `archived` | Rejected or screened out; the reason and authority are kept | You: restore |

An item's pull request is its `pr_url`: a GitHub pull request or a GitLab
merge request. The page names it by its number (`#123` on GitHub, `!123` on
GitLab).

## What gets built, and in what order

- **Approved and ready.** Only an approved item whose prerequisites have all
  shipped is ever handed to the implementation agent. An item you add yourself
  waits for approval too, unless you use **Add & approve**. A confirmed team's
  unanimous `approve` review or the enabled auto-approval agent can also
  grant approval. Approval never waives prerequisites or the landing gate.
- **Started work first.** An item that a round picked up but did not finish is
  resumed before anything new. After 3 rounds without finishing it is marked
  failed instead.
- **Priority, then approval time.** High, then Normal, then Low. **Auto**
  takes the priority the suggestion agent recommended (`add --priority`), or
  Normal when there is none. Within one priority, the item approved first goes
  first.
- **Prerequisites inherit priority.** A prerequisite takes the priority of
  the approved work waiting on it, so approving C as High pulls its
  prerequisites A and B forward too.

## Auto approval

The approver works on a snapshot of eligible waiting ideas from the start of
the round. It starts in parallel with the other agents and considers
`DIRECTION.md`'s focus and constraints, the spec's buildability and existing
notes from the human and team reviewers. Ideas suggested during the round
wait for the next approver. Builds picked at round start are unaffected;
approvals can be built next round or by a later team stage in the same round.

The runner applies structured results transactionally through the team
reviewer path and records them in `agent_reviews`. Only snapshot items still
waiting can be approved; intervening human decisions win. A human edit or
note made during the round defers the item to the next round, while team
reviewer notes written in parallel do not. An item without a verdict is
examined again next round. Approval uses
**Auto** priority and logs the round and reason under **auto-approval agent**.
The human can change it with the existing dashboard actions.

The approver can only approve. Other items stay waiting with a reason; it
cannot reject, archive, edit or reprioritise. If an item has prerequisites
still waiting, the same result must approve those prerequisites too, just
like **Approve with #A, #B**. Items the human unapproved or restored from the
archive remain for the human, even after later edits.

A held item is examined again only after its spec, prerequisites or notes
change; its own hold note does not trigger another examination. If no items
are left to examine, no approver starts and the round log says why. Its
prompt, transcript, response, applied result and summary live under
`runs/<round>/approve/`.

## Prerequisites

The suggestion agent may build on its own earlier ideas before they ship. It
assumes they will be built as written, and lists them as prerequisites.

- **On the Todos page.**
  - A row shows what an item builds on, and once approved, what it still
    waits for.
  - **Approve with #A, #B** approves an item together with every prerequisite
    still waiting for review.
  - The **Graph** view draws every arrow, from a prerequisite to what needs
    it.
- **Refused prerequisites.** Loops, unknown items, and archived items. An
  item that needs an archived one says it can never start until you change
  its prerequisites on its page.
- **Deleting.** Only archived items can be deleted, and only once nothing
  else needs them.

## Several builds at once

`shoemaker queue pick --max N` takes up to N items for builds side by side, in
the usual order (started items first). It skips any item whose spec's
**Files** part names a file (or a folder holding one) that an item already
taken names, so two builds never edit the same file. A spec with no Files part
conflicts with nothing.

## The CLI (`shoemaker queue`)

The agents use the CLI, `dashboard/bin/queue.mjs`, which `shoemaker queue`
runs with the project's `SHOEMAKER_STATE`. It opens the same SQLite file as
the web server, so it works whether or not the server is running. Every log
entry names its writer, from `--by` or `$SHOEMAKER_AUTHOR`.

```text
queue list [--status a,b] [--json]       every item, or only those statuses
queue show <id> [--json]                 one item with its spec and log
queue stats [--json]                     counts per status, and how many are ready
queue approval --json                   read the mode and eligible approval snapshot
queue next [--max N] [--exclude IDS] [--json]            next items (exit 3: nothing)
queue pick --run RUN [--max N] [--exclude IDS] [--json]  next + claim (exit 3: nothing)
queue add --title T [--body-file F|-] [--body TEXT] [--deps 3,5] [--priority high|normal|low] [--run RUN]
queue note <id> TEXT
queue claim <id> --run RUN
queue set <id> [--branch B] [--pr URL]
queue review <id> [--pr URL]             a draft pull request waits for the human's merge
queue ship <id> [--pr URL] [--note TEXT]
queue fail <id> --note TEXT
queue release <id> --note TEXT           give back an attempt the agent never used (the runner)
queue merged <id> [--pr URL] [--note T]  the item's pull request has merged (the runner)
```

`--mr URL` is accepted as another name for `--pr URL`. The JSON output names
the link `pr_url`. `--exclude` takes comma-separated item IDs; the team runner
uses it to avoid selecting an item twice across stages in the same round.

Exit codes: 0 is done, 1 is refused (the reason is on stderr), 2 is a usage
error, and 3 means there is nothing to build.

**There are no general CLI commands for human approval, prioritisation,
rejection, restoration or changing auto-approval mode.** Those are yours, on
the web page. Team reviewers use a separate scoped verdict protocol; the
runner alone applies its rules.
The CLI also refuses moves that would skip the approval step:

- It claims only an approved item, or one already in progress.
- It ships only an item that is in progress or waiting for a merge.
- Its pull request links must be `http(s)` addresses.

Two moves are for the runner:

- **`release`** gives back an attempt when the agent never started, for
  example because of a usage limit. The first attempt returns to the queue.
- **`merged`** records a merge seen on the forge. It also settles an item
  that had failed but whose pull request merged later.

Retry and Restore start an item afresh: its old branch and pull request links
move into its log.

## Team review stages

Each review stage works on a snapshot of waiting ideas and its configured
reviewers. The first turns run in parallel; with multiple reviewers, a
second parallel turn resumes those sessions with all first-turn item notes.
Reviewers can then answer each other's reasoning. Verdict records identify
the round, stage, role and individual reviewer as well as the verdict and
reason. The last successful verdict is each reviewer's vote.

Authority is fixed by the confirmed team, not by a reviewer-supplied request:

- `advisory` records notes and verdicts without changing status.
- `filter` screens an item out only when a majority of the stage's reviewers
  reject it.
- `approve` approves an item only when all reviewers in the stage approve it.
- Any result that meets neither threshold leaves the idea with the human.
  Missing votes prevent unanimous approval.

Thresholds count all reviewers configured for that stage. Only a `filter`
reviewer's rejection contributes to screening; automatic approval requires
every reviewer to have `approve` authority and vote to approve. Mixed
authority never gives an advisory reviewer extra powers.

The decision and the authority used are recorded in the item's existing log.
Screened-out items remain visible in the archived queue and can be restored;
agent-approved items remain visible in the approved queue and can be changed
by the human. Review decisions are transactional and apply only while the
item is still waiting, so a late reviewer cannot replace a human decision.

The queue migrates existing databases in `initSchema()`. Existing commands
and their exit codes are unchanged. The original `queue review` command
still means that a built item has a draft PR waiting for a human merge; it is
distinct from a team reviewer assessing an unbuilt idea.

Non-build team workers return structured `proposals`, `reviews` and/or
`report` data. The runner checks those fields against the worker's assigned
capabilities before applying effects; a worker cannot approve an item merely
by emitting an approval verdict. Reviews carry an item `id`, a `verdict`
(`approve`, `reject` or `abstain`) and a nonempty `body` with the reason.
The stage's confirmed roster supplies identity and authority.

The migration adds `agent_reviews` for each reviewer's latest vote on an
item in a round and stage, and `agent_review_decisions` for idempotent stage
decisions. Every discussion turn is retained in the existing `comments`
log. `team_proposals` counts ideas across the whole round, including ideas
already approved or screened out, so later stages cannot reset `per_round`.

For runner debugging, `dashboard/bin/team.mjs apply-result CONTEXT RESULT`
applies a non-build result, and `settle-stage CONTEXT` aggregates its final
votes. They accept runner-created JSON files and are refused from team
and auto-approval agent worktrees. The auto-approval worker uses the same
read-only tools, result schema and runner-only application path. These are
not general-purpose human approval commands. The guard continues to block
agents from accessing `queue.db` directly.

## A round, as a runner script does it

```sh
export SHOEMAKER_STATE="<state-dir>" SHOEMAKER_AUTHOR="run.sh"
shoemaker queue list --status in_progress,review,failed --json   # reconcile: merged PR → queue merged, closed → queue fail
if [ "$(shoemaker queue stats --json | jq .proposed)" -lt 5 ]; then
  SHOEMAKER_AUTHOR="suggestion agent" claude -p "<suggestion prompt>" &   # adds ideas with queue add
fi
if item="$(shoemaker queue pick --run "$RUN" --json)"; then              # exit 3: nothing approved is ready
  SHOEMAKER_AUTHOR="implementation agent" claude -p "<implementation prompt + $item>"   # set / ship / review / fail
  # if claude exited at once with no turns: shoemaker queue release <id> --note "<why>"
fi
wait
```

Capping the review backlog (here at 5) keeps an hourly suggestion agent from
filling the list faster than you read it. If nothing is ready, the
implementation agent is not started at all.
When auto approval is enabled, the runner also snapshots
`queue approval --json` before starting workers and runs the approver
alongside them. The round waits for its result even when it is the only
agent with work.
