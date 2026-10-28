# Direction page

The **Focus** section of `DIRECTION.md` says what the agents work toward:
every agent reads it each round. The dashboard's **Direction** page lets
you steer it with rough notes instead of editing the file.

## Notes become goals at the next round

Write anything in **Your notes**: an idea, a worry, something to stop
doing. A note waits for the next round; you can delete it until then.

When the next round starts, before any prompt quotes `DIRECTION.md`, the
runner sends the waiting notes and the current goals to the interpreter.
This is the same tool-free Claude Code session the Team page uses, with
`apply_model`, `apply_effort` and `APPLY_TIMEOUT` ([team.md](team.md)).
It returns the complete new goal list and one line per note saying what
it did. A note can add a goal, add to or reword one, merge goals, or stop
work on a topic, which removes that goal ("enough tag work for now").
Shoemaker validates the answer and writes the list into Focus. That round's
agents already read the new goals.

Each goal is one bullet, `- **Title:** what agents work toward`. Bullets
the notes left alone keep their lines exactly as written, and the rest of
the file is never touched. The page lists the goals with where each came
from (a note, or `DIRECTION.md`), and marks the ones the latest round added
or changed.

## Keep or remove

To keep a goal, do nothing. **Remove** takes a goal out of Focus at once,
so new work on it stops from the next round; ideas already in the queue
stay until you reject them. You can still edit `DIRECTION.md` by hand:
bullets you add under Focus show up as goals.

## When it fails

If the interpreter fails, times out or returns an answer that does not pass
validation, the notes stay waiting, `DIRECTION.md` stays as it was, and the
round runs. The page and the run log say why. If you edit Focus by hand
while the notes are being read, your edit wins and the notes wait for the
next round. While a round reads the notes, the page waits and refuses new
ones. A dry run only reports the waiting notes.

## Records

The dashboard and the runner keep Direction state under
`$SHOEMAKER_STATE/direction/`; the guard keeps agents out of it, as it does
`DIRECTION.md`. `notes.json` holds the notes, with each read note's outcome
and round (the latest 200 read notes are kept). `goals.json` records which
notes shaped each goal and what the latest round added or changed.
`last-apply.json` records the latest reading: round, status, model, effort
and any error. Interpretation prompts and output live in
`interpretation-runs/<id>/`.
