# Shoemaker dashboard

Shoemaker's web dashboard and queue CLI. The suggestion agent adds ideas to
the queue, you approve or reject them on the Todos page, and the
implementation agent builds the approved ones. The queue contract is
[`../docs/queue.md`](../docs/queue.md).

The **Team** page shows this default pair as the default team and lets you
add, edit and remove roles, each with an optional model and effort. Changes
wait until the next round, which interprets the descriptions in a tool-free
Claude Code session (`bin/round-start.mjs`), validates the result and
switches the team. A reviewer may have `advisory`, `filter` or `approve`
authority, with decisions and reasons preserved in item logs. See
[`../docs/team.md`](../docs/team.md) for the schema and voting rules.

The **Direction** page collects your notes. The next round, through the
same interpreter, turns them into goals in `DIRECTION.md`'s Focus section;
Remove takes a goal out at once. See
[`../docs/direction.md`](../docs/direction.md).

Node.js ≥ 18; one dependency, `better-sqlite3`. No build step.

## Run

In a managed project, `shoemaker dashboard` starts it with the project's state
directory. By hand:

```bash
npm install
SHOEMAKER_STATE="<state-dir>" npm start                 # reads <state-dir>/dashboard.json, uses <state-dir>/queue.db
SHOEMAKER_STATE="<state-dir>" npm run queue -- list     # the agents' CLI, on the same queue
```

Without `SHOEMAKER_STATE`, a development checkout uses `config.json` and
`data/queue.db` here (both gitignored). The Team and Direction pages require
an explicit state directory; their files and interpretation logs live below
`<state-dir>/team/` and `<state-dir>/direction/`.

| Variable | Effect |
|---|---|
| `SHOEMAKER_STATE` | The state directory: `dashboard.json` and `queue.db` in it |
| `SHOEMAKER_DASHBOARD_CONFIG` | Overrides the config file |
| `SHOEMAKER_DB` | Overrides the database file |
| `SHOEMAKER_AUTHOR` | Who writes the CLI's log entries (default `agent`; `--by` overrides) |

`dashboard.json`:

```json
{ "host": "127.0.0.1", "port": 6531, "password": "…", "secret": "…", "base_path": "", "project": "My app" }
```

- **`host`, `port`.** Defaults `127.0.0.1` and `6531`. Bind `0.0.0.0` only on
  a trusted LAN, and with a password.
- **`password`.** Empty disables sign-in; the server warns at start.
- **`secret`.** Signs the sign-in cookie; use a long random string.
- **`base_path`.** Serves the app under a subpath such as `/shoemaker`.
  Proxy that prefix without stripping it, and keep the `Host` header (Apache:
  `ProxyPreserveHost On`).
- **`project`.** Names the project while the queue still has the default
  name. A name changed on the page stays.
- **`target_dir`** (optional). The managed repository's path, shown on the
  Dashboard page.

A database from project-dashboard, the dashboard's predecessor, can be
reused: on first open its `mr_url` column becomes `pr_url`.

## Test

```bash
npm test             # node:test: queue/CLI, HTTP, graph, Team and Direction pages, interpreter
npm run check        # syntax check of every source file, then the tests
```

The tests use temporary state directories and databases. Interpreter cases
use stand-ins; they do not start real Claude Code sessions.

## Security

- **Trusted networks only.** Approving an item lets the implementation agent
  build it; a team change can delegate future approval under its explicit
  authority, and a note can change what the agents work toward. Don't expose the dashboard to untrusted networks.
- **Agent-written specs.** The preview shows them as plain formatting only:
  no scripts, styles, or `javascript:` links.
- **Changes come only from the page itself.** A change must be a JSON
  request, and when the browser sends an `Origin` it must be this host.

## Architecture

[AGENTS.md](AGENTS.md) maps the code: pluggable pages in `src/features/`, the
queue rules in `src/queue.js`, and the CLI in `bin/queue.mjs`.
Team configuration validation is shared with the runner in
`src/team-config.js`. `src/team.js` keeps waiting team changes and applies
them, `src/direction.js` keeps notes and the Focus goals, and both use the
headless interpreter in `src/interpreter.js`. `src/team-results.js` applies
capability-checked worker results.
[docs/adding-a-feature.md](docs/adding-a-feature.md) is the recipe for a new
page.
