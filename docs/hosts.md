# Hosts: GitHub, GitLab, no remote

How `shoemaker land` publishes on each host, what the login needs, and the host
settings worth turning on. Read the section for the project's `HOST`.

## GitHub (`HOST=github`)

**Login.** Use `shoemaker login`, run by the user in their own terminal.

- *Browser* (the default): `gh auth login --web`. The OAuth token does not
  expire.
- *Token*: a classic PAT with `repo` and `read:org`, or a fine-grained token
  for that repository only, with these permissions:
  - Contents read/write;
  - Pull requests read/write;
  - Checks read;
  - Commit statuses read;
  - Metadata read.

Both use `--insecure-storage`, which keeps the token in `~/.config/gh/hosts.yml`
rather than the keyring.

**What `shoemaker land` does.**

1. Pushes `shoemaker/*`.
2. Runs `gh pr create --base <default>`, with `--draft` in review.
3. Under `GATE=ci`, `shoemaker land wait` polls `gh pr view --json statusCheckRollup`.
   Once every check passed, it runs
   `gh pr merge --merge --match-head-commit <sha> --delete-branch`.

It never uses `--auto`, because `--auto` merges at once on a repository
without required checks.

**Host settings worth turning on** (the repository owner's call, in Settings):

- **Branch protection** on the default branch, requiring the CI check. This is
  the only real boundary: the harness's guard is client-side.
- *Allow auto-merge* is not needed; `shoemaker land` merges itself.

Branch protection on private repositories needs a paid plan. Without it, the
agent-side gate still holds, but nothing stops a human, or a broken tool,
from pushing directly.

## GitLab (`HOST=gitlab`), including self-hosted

**Login.** Use `shoemaker login`, run by the user in their own terminal.
The token must be a **legacy** token, from *Generate token → Legacy token*,
with scopes `api` and `write_repository`. A fine-grained token fails on
`/user`.

glab chooses the host from the git remote. If a self-hosted instance takes SSH
on one host (`git.example.org`) and serves the web UI and API on another, or
under a path (`gitlab.example.org/git`), log in as the SSH host with the API
host:

```sh
glab auth login --hostname <ssh host> --api-host <web host>/<path> --api-protocol https \
  --git-protocol ssh --insecure-storage --stdin
```

`shoemaker.conf` keeps the API host in `GITLAB_API_HOST`, and `shoemaker detect` reads
it from glab's config when an entry exists. Watch for an older glab earlier on
`PATH`, which cannot parse a newer one's config ([lessons.md](lessons.md)).

**What `shoemaker land` does.**

1. Pushes `shoemaker/*`.
2. Creates the MR through the API (`POST projects/:id/merge_requests`, with
   `remove_source_branch`). In review the title gets a `Draft:` prefix.
3. Under `GATE=ci`, `shoemaker land wait` sets auto-merge once the MR's pipeline
   exists on the pushed SHA. That is a
   `PUT .../merge merge_when_pipeline_succeeds=true sha=<sha>`, which GitLab
   accepts even while the pipeline is pending.
4. It then waits for the merge, and merges directly, pinned, if the pipeline
   passed before auto-merge was set.

**Host settings** (a Maintainer's call):

- *Settings → Merge requests → Pipelines must succeed*: refuses any merge
  without a green pipeline.
- A protected default branch, with push allowed to *No one* or Maintainers
  only.
- **A runner.** Without one, pipelines stay `pending` forever. Check with
  `glab api projects/:id/runners` and the project's *Settings → CI/CD →
  Runners*.

## No remote (`HOST=none`)

There is nothing to push and no CI, so:

- `GATE=ci` and `GATE=none` mean **review**: `shoemaker land open` leaves the
  rebased `shoemaker/*` branch for the human, who merges it locally
  (`git merge --ff-only shoemaker/…`).
- `GATE=local` lets `shoemaker land` run `SETUP_CMD` and `VERIFY_CMD` on the rebased
  commit, then fast-forward the default branch.
  - It does that only when the checkout that holds the default branch has no
    uncommitted changes; otherwise it leaves the branch for the human.
  - If no checkout holds the default branch, it moves the branch ref directly.

  This is the weakest gate: the agent's own machine runs the agent's own
  tests. Suggest adding a remote with CI when the project matters.

## Repositories with their own landing tooling

Some repositories already have scripts that push, open the MR and set
auto-merge, plus git hooks that keep agents off the default branch.
`shoemaker detect` lists them as `LANDING_SCRIPTS`. Prefer the repository's own
machinery: it encodes rules the harness cannot know. Do it like this:

- **`LAND_CMD`**: the repository's landing script. The run header tells the
  agent to publish with it instead of `shoemaker land`.
  - Add a line to `DIRECTION.md` → *Constraints* on how to wait for it in
    bounded steps.
  - Its own wait command must not run for more than about 9 minutes per call.
- **`GUARD_CMD`**: the repository's hook installer. the runner runs it, then
  checks that `pre-push` and `pre-commit` exist where `core.hooksPath` points.
- **Hook layout.** If the repository keeps its hooks somewhere unusual, check
  the dry run's "publish guard" line before the first real run.
