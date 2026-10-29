# shoemaker-status

A Claude Code mod that shows the status of your Shoemaker projects while you
work.

- **Status line**: one entry under the prompt per project, for example
  `👞 my-app: next 03:30 · 3 to review · 1 to merge · 2 ready`, or
  `round running 12m · 2 building` during a round. Several projects share the
  line: `👞 my-app: … │ other: …`.
- **`/shoemaker` pane**: the mode and model, the round (running, next tick,
  paused), queue counts, auto approval, a link to the dashboard, the checkout's
  commit and whether `shoemaker update` has commits waiting, the items being
  built, waiting for your merge or failed, the recent rounds and the latest
  log lines. `/shoemaker close` closes it.
- **Toasts** when a round starts and when it finishes, with what changed
  (`+1 shipped`, `+2 to review`).
- **Choosing projects**: `/shoemaker show <project>…` shows only those,
  `/shoemaker hide <project>…` drops some, and `/shoemaker all` shows every
  one again. The pane has Hide and Show buttons too. Every word after `show`
  or `hide` is a project's name, so a project named `all` is shown with
  `/shoemaker show all`. Hidden projects leave the status line and the toasts
  and are listed at the foot of the pane.
- **`/shoemaker off`** hides the status line and stops the background reads
  and toasts; **`/shoemaker on`** brings them back. `/shoemaker` still opens
  the pane while it is off.

The project selection and `off` are kept for your user on this machine, in
every session; sessions already running pick a change up at their next
refresh.

## Install

At the prompt of a Claude Code session:

```text
/plugin marketplace add tk4n9/shoemaker
/plugin install shoemaker-status@shoemaker
```

From a shell: `claude plugin install shoemaker-status@shoemaker`, after
`claude plugin marketplace add tk4n9/shoemaker`. The mod works in the
terminal, where `/plugin` runs, and in the sessions the desktop app starts on
your machine.

`/plugin` disables or removes it; `/config` shows its options.

## Options

| Option | Default | |
|---|---|---|
| `autoOpen` | `project` | Open the pane by itself: `project` (the session starts inside a project's repository, workspace or state directory), `always`, or `never`. The terminal seats a pane opened unasked only when it is wide enough |
| `pollSeconds` | `60` | How often the status is read again (at least 10) |

## How it reads the status

`scripts/collect.sh` finds projects the way `shoemaker update` does: from the
round units installed in `~/.config/systemd/user`, so every project of your
user shows wherever the session runs. A project that is set up but not
installed shows while the session's directory is inside it. Everything it
does is read-only:

- `systemctl --user show` for the timer, the round and the dashboard;
- `shoemaker queue stats`, `list` and `approval`, with `--json`;
- the front matter of `DIRECTION.md`, and `shoemaker.conf`, read as text and
  never sourced;
- `runs/`: the newest rounds and the latest log lines.

It never fetches: "behind upstream" counts the commits your checkout last
fetched. It needs bash, jq, systemd user services and Node.js, as Shoemaker
does.

## Developing

```sh
claude --plugin-dir mods/shoemaker-status   # a session with this copy loaded; saves reload it
claude plugin validate mods/shoemaker-status
claude plugin test mods/shoemaker-status    # tests/*.test.tsx, on a fictional project
```

A session that loads the folder lays the API's types in
`.claude-plugin/types/`, which `tsconfig.json` extends, so `tsc -p
mods/shoemaker-status` type-checks the mod; that folder is not committed.
