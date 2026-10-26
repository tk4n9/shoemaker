# Setting up CI as the merge gate

Use this when `shoemaker detect` reports no CI and the user wants `GATE=ci`. The
Shoemaker agent itself never edits CI: it is part of the gate. Setting CI up is
done during setup, with the user's approval, and lands like any other change:

1. Write the CI file on a branch.
2. Open a PR (a merge request on GitLab).
3. Let the user review and merge it, or merge it with their explicit go-ahead.

Until it has merged, `ship` behaves as `review`.

## What the CI must do

- Run on **pull requests / merge requests**, not only on pushes to the default
  branch. Otherwise `shoemaker land wait` never sees a check.
- Run the same checks as `shoemaker.conf`'s `SETUP_CMD` and `VERIFY_CMD`, so a
  green local verify and a green CI mean the same thing.
- Stay fast and deterministic. A flaky CI turns every run into a retry.

## GitHub Actions: `.github/workflows/ci.yml`

Adapt the setup steps to the stack that `shoemaker detect` reported. Node:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]          # the default branch
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci           # SETUP_CMD
      - run: npm test         # VERIFY_CMD
```

Python: use `actions/setup-python@v5` (`python-version: "3.12"`, `cache: pip`),
then `pip install -e ".[test]"` or `uv sync`, then `pytest`. A shell-only
repository needs no setup step: run `bash tests/the runner`.

Then suggest the host settings to the user. Their admin rights are needed:

- **Settings → Branches →** protect the default branch and require the `test`
  check.
- Or with the API, which the user runs:
  `gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input protection.json`.

## GitLab CI: `.gitlab-ci.yml`

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

test:
  image: node:22            # or python:3.12, or the image the project builds in
  timeout: 20m
  script:
    - npm ci                # SETUP_CMD
    - npm test              # VERIFY_CMD
```

**Before relying on it, check that a runner will pick the job up.** On a
self-hosted instance there may be none, and a pipeline that never leaves
`pending` gates nothing:

```sh
glab api projects/:id/runners | jq 'length'          # project runners
glab api projects/:id | jq .shared_runners_enabled    # instance runners allowed?
```

If there is no runner, tell the user. They may need to register one
(`gitlab-runner register`, a Maintainer task), or keep `GATE=local` or
`review` until there is one.

**Shell-executor runners ignore `image:`.** The job then runs with the
runner host's own toolchain, as user `gitlab-runner`. The log's "Preparing
the "shell" executor" line shows this. Make the script work on either
executor. For example, a Playwright suite needs
`npx playwright install --only-shell chromium` before the tests: it is a
no-op in the Playwright image, and it caches in the runner's home on a shell
runner.

Then suggest the setting *Settings → Merge requests → Pipelines must succeed*
(Maintainer). From the API, which the user runs:
`glab api -X PUT projects/:id -f only_allow_merge_if_pipeline_succeeds=true`.

## After CI is in place

1. Set `GATE=ci` in `shoemaker.conf`, if it is not already.
2. Run `the runner --dry-run`. The line "no CI to gate merges" should be gone.
3. Move `DIRECTION.md` to `mode: ship` when the user is ready.
