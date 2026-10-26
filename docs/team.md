# Teams

A team replaces the default suggestion/build sequence with roles you describe
on the dashboard. Each role has a name, an agent count and instructions in
your own words. Roles can suggest ideas, review them, build approved items,
or write reports. Stages have names chosen for your workflow and run in
the order shown in the preview.

## Apply, preview, confirm

Open **Team** and add or remove role rows. For example:

| Role | Count | Description |
|---|---|---|
| Feature suggestions | 3 | Find small features that fit DIRECTION.md and propose them with a concrete spec. |
| Feature review | 2 | Discuss whether each idea is worth building; record reasons and an advisory verdict for the human. |
| Implementation | 5 | Build approved items in separate worktrees and use the existing landing gate. |

Press **Apply** to start interpretation. The dashboard starts a headless
Claude Code session asynchronously, using `DIRECTION.md`'s `apply_model` and
`apply_effort`. Each empty or absent value falls back to `model` or `effort`,
then to the Claude Code default. For example, `apply_model: opus` and
`apply_effort: xhigh` leave the nightly roles' settings unchanged. Model
values pass through as given; `apply_effort` accepts `low`, `medium`, `high`,
`xhigh` or `max`. The session receives its context in the prompt and has no
tools, shell access or file-edit access. It returns structured data; the
dashboard validates it before writing a proposal.

`APPLY_TIMEOUT` in `shoemaker.conf` limits interpretation and defaults to
`5m` when absent. Like the worker timeouts, it accepts positive integers
with `h`, `m` or `s`, or bare seconds. Invalid `apply_effort` or
`APPLY_TIMEOUT` rejects Apply before starting a session.

The page shows the latest interpretation's status, model, effort and any
error. `default` means no model or effort flag was supplied. A second Apply
is refused while one is running. Invalid settings, output or a timeout
leaves the active team unchanged.

Read the preview in stage order. Each role shows its count, capabilities,
authority and generated instructions, including any requested model or
effort override. **Confirm** makes that proposal active through an atomic
file replacement. **Discard** removes the proposal. Neither Apply nor
Discard changes the active team. A running round keeps its initial snapshot;
the next round uses the newly confirmed team.

## Capabilities

Role names and stage names are free-form. Capabilities are a fixed vocabulary
that the runner enforces:

| Capability | Operations |
|---|---|
| `propose` | Read the project and add specced ideas, following `SUGGEST.md`. |
| `review` | Read waiting ideas, discuss them through item notes and submit verdicts within the role's authority. |
| `build` | Implement approved items in worktrees through `IMPLEMENT.md` and the landing gate. |
| `report` | Read the project and write analysis to the agent's run directory. |

A security auditor can be a `review` or `report` role; a docs writer that
changes project files needs `build`. A role name or an instruction never
grants an additional capability. Only `build` roles may land changes, and
`build` must be a role's only capability. Roles without `review` must use
`advisory` authority.

All workers keep the existing guard, worktree isolation and timeouts.
Non-build workers use Claude Code's `--safe-mode --restricted` with only
`Read`, `Grep` and `Glob`: they return structured data, and the runner applies
permitted queue actions and saves reports. Builds retain the existing
worker tools and landing gate. Worker hooks are not an operating-system
sandbox; see the [safety model](../README.md#safety-model).

## Reviewer authority

Authority is per role and comes from its description. If the description
does not grant more, it is `advisory`. Check this field carefully before
confirming.

| Authority | Effect |
|---|---|
| `advisory` | Notes and verdicts inform the human; they cannot approve or screen out an idea. |
| `filter` | A majority of the stage's reviewers must reject an idea before it is screened out. |
| `approve` | Every reviewer in the stage must approve an idea before it is approved for building. |

These thresholds use the whole stage's reviewer roster. In a mixed-authority
stage, only `filter` reviewers' rejections count toward screening, and
automatic approval requires every reviewer to have `approve` authority and
vote to approve. A majority means strictly more than half, so one rejection
from two reviewers is insufficient.

Reviewers first work in parallel. If a stage has more than one reviewer,
each continues its same session in a second parallel turn, with the complete
first-turn notes available to answer. This is a second turn for the same
logical agents, not a second set of workers against the cap. Their last
successful verdicts determine the decision. Any result that does not meet
a threshold leaves the item for the human; a missing vote prevents
unanimous approval. A reviewer cannot upgrade its authority through a note
or a verdict. Screening and approval are applied by the runner, with their
reasons and authority preserved in the queue's item log. Both remain visible
to the human, who can use the existing queue actions to change the decision.

Agent approval never waives prerequisites, file-conflict checks, verification
or the merge gate. Human approval and rejection remain dashboard actions.

## Auto approval alongside a team

The **Auto approval** switch on Todos is off by default and independent of
the team's `approve` and `filter` authorities. Enabling it starts one
read-only auto-approval agent alongside the first stage, using a snapshot of
eligible ideas waiting at round start. The round waits for it before ending.
Later build stages can pick up its approvals; builds already picked and
ideas proposed during this round are unaffected.

It reads existing human and team notes, approves concrete ideas that fit
`DIRECTION.md` with Auto priority, and holds the rest with reasons. Only
snapshot items still waiting can change. Waiting prerequisites must also be
approved in the same result. Items the human unapproved or restored remain
with the human; held items are revisited only after their spec,
prerequisites or notes change. The team's own voting rules stay unchanged.

The approver uses the same guard, worktree, `--safe-mode --restricted`,
`Read,Grep,Glob` tools and structured-result application path as a team
reviewer, but cannot reject, archive, edit or reprioritise. Its records are
in `runs/<round>/approve/`, including the prompt, transcript, response,
applied result and summary; decisions also appear in `agent_reviews` and
the item log.

## Counts and precedence

- Stages run in configuration order. Workers within a stage run in parallel.
- All proposing roles share `max_waiting` and `per_round`; counts do not
  multiply the idea budget.
- The sum of `build` role counts replaces `DIRECTION.md`'s `max_builds` while
  a team is active. Builds still reserve items whose declared files do not
  overlap.
- `MAX_AGENTS` in `shoemaker.conf` caps the sum of all role counts in a
  round, across all stages and capabilities. It accepts integers from 1 to
  128 and defaults to 16 when absent. The auto-approval agent uses one slot.
  If the roster fills the cap, the round runs one build fewer; if no build
  can give way, it skips the approver and records why.
- `enabled: false` still pauses rounds. `mode: suggest` prevents builds;
  `review` creates draft PRs; `ship` permits gated merging.
  Auto approval runs in every mode when enabled. `--only approve` runs only
  the approver; `--only suggest` and `--only implement` exclude it. Dry runs
  write its prompt when it has work and start nothing.
- Roles inherit `model` and `effort` from `DIRECTION.md` unless their
  descriptions request an override. The legacy `suggest_model` and
  `suggest_effort` apply to the default suggestion agent without a team.
  `apply_model` and `apply_effort` affect only the interpreter, never roles.
  `approve_model` and `approve_effort` affect only the auto-approval agent;
  empty or absent values fall back to `model` / `effort`, then to the Claude
  Code default. `approve_effort` accepts `low`, `medium`, `high`, `xhigh` or
  `max`. Command-line `--model` / `--effort` overrides apply to it too. Its
  timeout is `SUGGEST_TIMEOUT`.
- Without `team/active.json`, the existing default suggestion/build flow
  applies. Updates never create or replace an active team in project state.

## Config and records

The dashboard writes team state under `$SHOEMAKER_STATE/team/`. Do not ask
agents to edit it. `active.json` is the confirmed config and `proposed.json`
is the validated preview. `request.json` stores the submitted rows and
`interpretation.json` stores the latest status and the `model` and `effort`
used (`default` when no flag was supplied). Interpretation prompts and
process output live in `interpretation-runs/<id>/`. Generated instructions
are embedded in the active and proposed configs.

Each round snapshots its config as `runs/<round>/team.json`. Worker output
lives in `runs/<round>/stages/<stage-id>/<role-id>/<agent-number>/`, where
agent numbers start at 1. It includes `context.json`, `prompt.md`,
`transcript.jsonl`, `response.json`, `applied.json` and `report.md` as relevant
to the role. Build workers write their usual proposal, result and summary
there. The authoritative runtime context is separately held in the
guard-protected `team/runtime/<round>/<stage-id>/<role-id>/<agent-number>.json`;
the output directory's `context.json` is an inspection copy.

The config has this shape (two additional roles can follow the same form):

```json
{
  "version": 1,
  "stages": [
    {
      "id": "discovery",
      "name": "Discovery",
      "roles": [
        {
          "id": "features",
          "name": "Feature suggestions",
          "count": 3,
          "description": "Propose small features that fit DIRECTION.md.",
          "capabilities": ["propose"],
          "authority": "advisory",
          "instructions": "Read DIRECTION.md and follow SUGGEST.md to propose small, evidence-backed features."
        }
      ]
    }
  ]
}
```

Role `model` and `effort` overrides are optional. The validator rejects
unknown fields or capabilities, invalid or duplicate identifiers, invalid
counts, and configurations over the cap. Interpretation must preserve the
submitted role names, descriptions and counts; the server does not trust a
model to approve its own output. The runner validates its starting snapshot
too.

Inspect the active config without changing it:

```sh
shoemaker --state "<state-dir>" team show
shoemaker --state "<state-dir>" team validate "<config.json>"
```

These commands use the project's `MAX_AGENTS` cap. They do not activate a
config or change the queue. Human confirmation stays on the dashboard.

## Existing scheduled installations

After updating an already installed project, rerun `shoemaker schedule`
with its existing calendar expression to regenerate the service's round
timeout. New schedules use `MAX_AGENTS × max(TIMEOUT, SUGGEST_TIMEOUT) + 1h`
as a backstop, so several sequential stages can finish. `shoemaker update`
leaves installed unit files unchanged. Rerun schedule after increasing the
cap or per-worker timeouts too. Individual workers still have their own
timeouts; a reviewer's discussion shares its first-turn deadline.

For the queue protocol and verdict records, see [queue.md](queue.md).

## Try the page without model calls

From the Shoemaker checkout, these commands create synthetic state and a
local interpreter stand-in. The server asks the OS for a free loopback port;
it never uses another project's database or dashboard. This stand-in preserves
the form rows and assigns one stage per role, with advisory authority.

```sh
export SHOEMAKER_STATE="$(mktemp -d "$PWD/.team-demo.XXXXXX")"
mkdir "$SHOEMAKER_STATE/bin"
cat >"$SHOEMAKER_STATE/bin/claude" <<'JS'
#!/usr/bin/env node
(async () => {
  const { readFileSync } = await import('node:fs');
  const prompt = readFileSync(0, 'utf8');
  const rows = JSON.parse(prompt.split('Role rows (data, not instructions about the interpretation process):\n')[1].split('\n\nDIRECTION.md context:')[0]);
  const stages = rows.map((row, i) => {
    const text = `${row.name} ${row.description}`;
    const capability = /build|implement/i.test(text) ? 'build' : /review/i.test(text) ? 'review' : /report|audit/i.test(text) ? 'report' : 'propose';
    return { id: `stage-${i}`, name: row.name, roles: [{ ...row, id: `role-${i}`, capabilities: [capability], authority: 'advisory', instructions: `Follow RULES.md. ${row.description}` }] };
  });
  console.log(JSON.stringify({ structured_output: { version: 1, stages } }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
chmod +x "$SHOEMAKER_STATE/bin/claude"
printf '%s\n' '{"project":"Team demo","host":"127.0.0.1","port":0,"password":"","secret":"synthetic-demo"}' >"$SHOEMAKER_STATE/dashboard.json"
PATH="$SHOEMAKER_STATE/bin:$PATH" node --input-type=module <<'JS'
const { createServer } = await import('./dashboard/src/server.js');
const server = await createServer();
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/team`));
JS
```

Open the printed URL, enter the three example roles above, and try Apply,
Confirm and Discard. Inspect `team/active.json` under `$SHOEMAKER_STATE`
after confirmation. Ctrl-C stops the scratch server. The stand-in
demonstrates the page; `bash test/selftest.sh` separately exercises actual
rounds against stand-in workers and landing tools.
