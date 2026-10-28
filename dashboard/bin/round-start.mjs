#!/usr/bin/env node
// Run by run.sh at the start of a round, before any prompt quotes DIRECTION.md
// and before the team is snapshotted: waiting Direction notes become goals,
// then waiting team changes become the active team. Either can fail on its
// own; what failed stays as it was and waits for the next round.
//
//   round-start.mjs ROUND_ID       apply what waits
//   round-start.mjs --dry-run      only say what waits
import { agentWorktree, teamContext } from '../src/team-context.js';
import { DirectionService } from '../src/direction.js';
import { TeamService } from '../src/team.js';

const state = process.env.SHOEMAKER_STATE;
const [arg = ''] = process.argv.slice(2);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const used = (r) => `model ${r.model}, effort ${r.effort}`;
const changed = (r) => (r.changes || []).map((c) => `${c.name} ${{ edit: 'edited', add: 'added', remove: 'removed' }[c.change]}`).join(', ');

async function step(name, action) {
  try { await action(); }
  catch (error) {
    console.log(`${name}: WARNING: ${error.message}`);
    process.exitCode = 1;
  }
}

if (!state) {
  console.error('round-start: SHOEMAKER_STATE is required');
  process.exit(2);
}
if (agentWorktree() || teamContext()) {
  console.error('round-start: only the runner applies Direction notes and team changes, outside agent worktrees');
  process.exit(2);
}
const direction = new DirectionService({ state });
const team = new TeamService({ state });

if (arg === '--dry-run') {
  await step('direction', () => {
    const { waiting } = direction.status();
    if (waiting) console.log(`direction: ${plural(waiting, 'note')} would be read at the start of a real round`);
  });
  await step('team', () => {
    const { changes } = team.status();
    if (changes) console.log(`team: ${plural(changes, 'change')} would be applied at the start of a real round`);
  });
} else {
  await step('direction', async () => {
    const r = await direction.applyNotes({ round: arg });
    if (r.status === 'applied') console.log(`direction: read ${plural(r.notes, 'note')}; Focus now has ${plural(r.goals, 'goal')} (${used(r)})`);
    if (r.status === 'failed') console.log(`direction: WARNING: could not read ${plural(r.notes, 'note')} (${r.error}); they wait for the next round`);
  });
  await step('team', async () => {
    const r = await team.applyPending({ round: arg });
    if (r.status === 'applied' && r.default) console.log(`team: back to the default team (${changed(r)})`);
    else if (r.status === 'applied') console.log(`team: applied ${plural(r.changes.length, 'change')}: ${changed(r)} (${used(r)})`);
    if (r.status === 'failed') console.log(`team: WARNING: could not apply the waiting changes${r.changes.length ? ` (${changed(r)})` : ''}: ${r.error}; this round runs the current team`);
  });
}
