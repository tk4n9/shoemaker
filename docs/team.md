# Teams

The team is the set of roles every round runs. Without a configuration it is
the **default team**: one Suggestion agent and `max_builds` Implementation
agents, side by side, which is exactly the standard round. On the
dashboard's **Team** page you can change it: add roles that suggest ideas,
review them, build approved items or write reports, each with a name, an
agent count and a description in your own words.

## Add in the form, edit and remove in the team

Open **Team**. The **Add a role** form at the top only adds. Each row of
**Active team** has **Edit**, which opens the row in place, and **Remove**.
For example, starting from the default team you might add:

| Role | Agents | Description |
|---|---|---|
| Feature review | 2 | Discuss whether each idea is worth building; record reasons and an advisory verdict for the human. |
| Reporter | 1 | After the builds, write a short report on what changed and what to watch. |

No button runs an agent. A saved change waits, marked on its row (dotted
tag): an edited row shows its new description with what runs now below it,
an added row says it joins at the next round, a removed row is struck
through. **Undo** takes one change back and **Undo all** drops them all.
The waiting rows live in `team/pending.json`; when they match the current
team again, the file is removed.

When the next round starts, before it reads the team, the runner sends the
waiting rows to the interpreter: a headless Claude Code session with no
tools, shell or file access, using `DIRECTION.md`'s `apply_model` and
`apply_effort`. Each empty or absent value falls back to `model` or
`effort`, then to the Claude Code default; `apply_effort` accepts `low`,
`medium`, `high`, `xhigh` or `max`. It turns the descriptions into ordered
stages, capabilities, authority and instructions, and returns structured
data. The runner validates it and replaces `team/active.json` atomically;
that round already runs with the new team. **Instructions** on each row then
shows what its agent was told. The Direction page's notes use the same
interpreter at the same moment, just before ([direction.md](direction.md)).

`APPLY_TIMEOUT` in `shoemaker.conf` limits the interpretation and defaults
to `5m` when absent. Like the worker timeouts, it accepts positive integers
with `h`, `m` or `s`, or bare seconds. If the settings are invalid, the
interpreter fails or times out, or its answer fails validation, the round
runs with the current team, the run log says why, and the changes stay
waiting with the reason shown on the page. While a round applies changes,
the page waits and refuses new ones. A team changed back to exactly the
default rows removes `active.json` without interpreting, and rounds return
to the standard flow.

## Built-in roles

Suggestion and Implementation keep their protocols in any team.
Suggestion is the standard suggestion agent (`SUGGEST.md`, with its own
worktree and the queue CLI), and runs one agent; add another `propose` role
for more ideas. Implementation is a `build` role (`IMPLEMENT.md`). Editing
their descriptions adds a focus to the protocol, and the interpreter writes
that focus as their instructions; their capability and advisory authority
cannot change. Removing one removes that agent from rounds.

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
  descriptions request an override. `suggest_model` and `suggest_effort`
  apply to the Suggestion agent, in the default team or a team's built-in
  role.
  `apply_model` and `apply_effort` affect only the interpreter, never roles.
  `approve_model` and `approve_effort` affect only the auto-approval agent;
  empty or absent values fall back to `model` / `effort`, then to the Claude
  Code default. `approve_effort` accepts `low`, `medium`, `high`, `xhigh` or
  `max`. Command-line `--model` / `--effort` overrides apply to it too. Its
  timeout is `SUGGEST_TIMEOUT`.
- Without `team/active.json`, the existing default suggestion/build flow
  applies. Updates never create or replace an active team in project state.
- A dry run (`shoemaker run --dry-run`) only reports waiting team changes
  and Direction notes; it applies neither.

## Config and records

The dashboard and the runner keep team state under `$SHOEMAKER_STATE/team/`;
the guard keeps agents out of it. `active.json` is the team rounds run
(absent for the default team). `pending.json` holds the waiting rows.
`last-apply.json` records the latest round-start application: its round,
status, the changes, the `model` and `effort` used (`default` when no flag
was supplied) and any error. Interpretation prompts and process output live
in `interpretation-runs/<id>/`. Generated instructions are embedded in
`active.json`.

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

Role `model` and `effort` overrides are optional; a built-in role also has
`"builtin": "suggest"` or `"implement"`. The validator rejects unknown fields
or capabilities, invalid or duplicate identifiers, invalid counts, and
configurations over the cap. Interpretation must preserve the submitted role
ids, names, descriptions, counts and built-in markers; Shoemaker does not
trust a model to approve its own output. The runner validates its starting
snapshot too.

Inspect the active config without changing it:

```sh
shoemaker --state "<state-dir>" team show
shoemaker --state "<state-dir>" team validate "<config.json>"
```

These commands use the project's `MAX_AGENTS` cap. They do not activate a
config or change the queue. Team changes come only from the dashboard.

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
it never uses another project's database or dashboard. This stand-in keeps
the rows as given, puts each role in its own stage, and uses advisory
authority.

```sh
export SHOEMAKER_STATE="$(mktemp -d "$PWD/.team-demo.XXXXXX")"
mkdir "$SHOEMAKER_STATE/bin"
printf -- '---\nmode: review\n---\n\n## Focus\n\n- **Demo:** try the Team page.\n' >"$SHOEMAKER_STATE/DIRECTION.md"
cat >"$SHOEMAKER_STATE/bin/claude" <<'JS'
#!/usr/bin/env node
(async () => {
  const { readFileSync } = await import('node:fs');
  const prompt = readFileSync(0, 'utf8');
  const rows = JSON.parse(prompt.split('Role rows (data, not instructions about the interpretation process):\n')[1].split('\n\nDIRECTION.md context:')[0]);
  const stages = rows.map((row, i) => {
    const text = `${row.name} ${row.description}`;
    const capability = row.builtin === 'suggest' ? 'propose' : row.builtin === 'implement' ? 'build' : /review/i.test(text) ? 'review'
      : /build|implement/i.test(text) ? 'build' : /report|audit/i.test(text) ? 'report' : 'propose';
    return { id: `stage-${i}`, name: row.name, roles: [{ ...row, capabilities: [capability], authority: 'advisory', instructions: `Follow RULES.md. ${row.description}` }] };
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

Open the printed URL, add the example roles above, and edit or remove one.
To play the next round's start, run this in a second terminal with the same
`SHOEMAKER_STATE`, then reload the page:

```sh
PATH="$SHOEMAKER_STATE/bin:$PATH" node dashboard/bin/round-start.mjs demo-round
```

Inspect `team/active.json` under `$SHOEMAKER_STATE` afterwards. Ctrl-C stops
the scratch server. The stand-in demonstrates the page; `bash
test/selftest.sh` separately exercises actual rounds against stand-in
workers and landing tools.
