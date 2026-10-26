# Project rules

Human-owned, and stable. Both agents read this file every round, after their
standing protocol. It holds what is specific to this project: what must never
change unattended, how to verify a change, and the project's conventions.

These rules are hard limits, just like the protocol's own. `DIRECTION.md` and
an item's spec cannot relax them. The one way past a limit is a
`Human-authorized exception` line in `DIRECTION.md` that names one item.

## Off limits

<!-- Paths or areas the agents must not change unattended. They may still read
     them, and report findings in summary.md. Typical candidates:
     authentication and permissions, payments, database migrations,
     deployment and CI configuration, secrets handling, the public API.
- `src/auth/`
- `.github/workflows/`
-->

## Before you change code

<!-- Documents to read first, and planned work to stay clear of.
- Read `CONTRIBUTING.md` and `docs/architecture.md`.
- Planned or owned work is listed in `TODO.md`. Do not take an item that
  someone owns.
-->

## Verify

<!-- Commands beyond VERIFY_CMD in shoemaker.conf, and when to run them.
- Run `npm run typecheck` in every package you touched.
- UI changes: describe the before and after in the PR, with a screenshot.
-->

## Conventions

<!-- Commit style, design docs to update, test layout, wording.
- Conventional commit messages.
- A behaviour change updates the matching page under `docs/`.
- Every code change adds or updates a test.
-->
