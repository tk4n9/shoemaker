# AGENTS.md — Shoemaker dashboard

Entry point for AI agents working on the dashboard. Read this first; follow
links for depth (progressive disclosure — don't load everything at once).

## What this is
Shoemaker's web dashboard and queue CLI. A suggestion agent proposes todos,
the human approves them with a priority (or rejects them), and an
implementation agent builds the approved ones once their prerequisites have
shipped. That pair is the default team; on the Team page the human can
change it into custom stages, and review roles can receive explicit
filtering or approval authority. On the Direction page the human's notes
become goals in `DIRECTION.md`'s Focus. Both kinds of change wait for the
next round, which interprets and applies them before any agent starts.

- One managed project per running dashboard. Its state directory
  (`$SHOEMAKER_STATE`) holds `dashboard.json` and `queue.db`.
- The queue contract (statuses, build order, CLI): **[../docs/queue.md](../docs/queue.md)**.
- The team schema, capability limits and voting rules: **[../docs/team.md](../docs/team.md)**.
- The Direction page's notes and goals: **[../docs/direction.md](../docs/direction.md)**.

## The one thing to know: features are pluggable
A page is **one file** in `src/features/`. The registry auto-discovers it — there
is no central route list. To add a page:

```bash
npm run new:page <name> "Label"   # scaffold
# edit src/features/<name>.js
npm run check                     # syntax + tests (your feedback loop)
```

→ **Full recipe + the `ctx` API + a worked PDF-viewer example: [docs/adding-a-feature.md](docs/adding-a-feature.md).**

## Structure
```
src/
  core/        generic plumbing — rarely edit
    registry.js  auto-discovers src/features/*.js
    router.js    :param path matching
    context.js   the ctx object handed to handlers (feature API)
    layout.js    shared HTML chrome + esc() + fmtTime()
    http.js      send/json/redirect/parseBody/serveStatic
    auth.js      single-password signed-cookie gate
  features/    one file per page (todos.js is the reference example)
  queue.js     the queue rules: statuses, moves, readiness, build order, log
  team-config.js shared schema validation and project team settings
  default-team.js the default team (the standard round) as role rows
  team.js      waiting team changes (pending.json), applied at round start
  direction.js notes, the Focus goals of DIRECTION.md, applied at round start
  interpreter.js the tool-free headless interpreter, settings and a pid lock
  team-results.js validates structured worker effects before applying them
  team-context.js resolves authoritative context from worktree metadata
  graph.js     layered dependency-graph layout, drawn as server-side SVG
  config.js    loads dashboard.json ($SHOEMAKER_STATE, or $SHOEMAKER_DASHBOARD_CONFIG)
  db.js        sqlite schema + connection + migrations ($SHOEMAKER_STATE/queue.db, or $SHOEMAKER_DB)
bin/queue.mjs  the agents' CLI over the same database (`shoemaker queue`)
bin/team.mjs   team inspection/validation and runner-only result settlement
bin/round-start.mjs  run.sh's first step: Direction notes, then team changes
scripts/       new-page.mjs (scaffolder), check.mjs (feedback loop)
test/          node:test tests: smoke (HTTP), queue (rules + CLI), graph, team, direction
docs/          deeper guides
public/        app.js, app.css (the Seam style: tokens and rules at its top), fonts/ (Atkinson Hyperlegible, OFL)
```

## Data model
- `config(id=1, project_name, show_completed, theme, container_align, todo_view)`
- `todos(id, title, explanation, position, created_at, done, status, priority, source, run_id, last_run, branch, pr_url, attempts, approved_at, shipped_at, archived_at, status_note, updated_at, suggested_priority)` — priority 0 is Auto (suggested_priority, else Normal)
  — `explanation` is the spec; `done` mirrors `status = 'shipped'` for old readers;
  `pr_url` is a GitHub pull request or a GitLab merge request. An imported
  project-dashboard database is migrated (`mr_url` → `pr_url`) and may keep an unused `due_date`.
- `todo_deps(todo_id, dep_id)` — `dep_id` is a prerequisite of `todo_id`.
- `comments(id, todo_id, body, author, created_at)` — the item's log; every move writes one.
- `agent_reviews` — latest vote per item, round, stage and reviewer; all turns remain in `comments`.
- `agent_review_decisions` — idempotent stage settlement and authority used.
- `team_proposals` — shared per-round idea budget, including ideas since approved or archived.

## Boundaries
**Always:** new pages in `src/features/`; escape output with `esc()`; parameterized SQL;
change item status only through `src/queue.js` (it checks the move and writes the log);
add a test + run `npm run check` before claiming done.
**Ask first:** new runtime dependency (project is near-zero-dep); auth/schema changes; build step or frontend framework;
visual styling changes (the visual direction is not chosen yet).
**Never:** add general agent commands/endpoints for human approval, priority,
rejection or restoration. Confirmed team reviewers return scoped verdicts;
only the runner applies the fixed authority rules while an item still waits
for review. Do not let agent output raise its capability or authority.
Never commit `config.json`/`data/`/secrets`, emit unescaped user/db HTML, or
render agent-written markdown without
`sanitize()` in `public/app.js`.

Team constraints: validate all model output; preserve submitted role ids,
names, descriptions, counts and built-in markers; default reviewer authority
to advisory; built-in roles keep their capability and protocol. Only the
human's saved changes reach the interpreter, and only the runner, outside
agent worktrees, applies its validated result. A round uses one config
snapshot. Non-build workers use read-only tools and return
structured effects; build workers remain limited to their assigned item.
Capability and authority checks use guard-protected runtime context, not
agent-writable copies in run output. Direction notes change only the Focus
bullets, through a validated answer; never overwrite a Focus section the
human edited while the notes were read.

## Conventions
- Mutations are JSON `POST` endpoints; client (`public/app.js`) does fetch-then-reload (server DOM = source of truth).
- Queue refusals are `QueueError`s: HTTP 400 `{ error }` on the page, exit 1 in the CLI.
- Host-neutral wording: "pull request" / "PR" in the UI, logs and docs; `--mr` is only a CLI alias of `--pr`.
- Keep dependencies minimal; prefer Node built-ins. No build step.
- Test isolation via env: `SHOEMAKER_DB`, `SHOEMAKER_STATE`, `SHOEMAKER_DASHBOARD_CONFIG`.
