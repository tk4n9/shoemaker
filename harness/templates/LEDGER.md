# Ledger

Agent-owned and append-only: one entry per build, newest last. Each build is
one item from the queue, under its own run id `<round>-q<item>`. The agents
read the recent entries, so they do not repeat themselves. Humans react on the
dashboard (reject reasons, notes) or in `DIRECTION.md` → *Feedback on earlier
runs*, not here.

Entry format:

```markdown
### <run id> — <outcome> — #<item> <title>
- PR: <https link or none>; branch: `shoemaker/q<item>-...`
- verified: <commands run and their results, one line>
- notes: <judgment calls, follow-ups, ideas for later (the suggestion agent reads these)>
```

Outcomes:

- `merged`;
- `review-open`: waiting for the human's merge;
- `unfinished`: the next round resumes it;
- `failed`;
- `no-op`: already on the default branch;
- `crashed`: the runner writes this when the agent ended without recording.

---
