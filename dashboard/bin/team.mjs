#!/usr/bin/env node
// Small runner/debugging interface. Human activation stays on the dashboard.
import { readFileSync } from 'node:fs';
import { validateTeam, readActiveTeam } from '../src/team-config.js';
import { agentWorktree, teamContext } from '../src/team-context.js';
import { applyTeamResult } from '../src/team-results.js';

try {
  const [command = 'show', file, cap] = process.argv.slice(2);
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  let result;
  if (command === 'show') {
    if (!process.env.SHOEMAKER_STATE) throw new Error('SHOEMAKER_STATE is required');
    result = readActiveTeam(process.env.SHOEMAKER_STATE);
  } else if (command === 'validate') {
    result = validateTeam(read(file), { maxAgents: Number(cap || 16) });
  } else if (['apply-result', 'settle-stage'].includes(command)) {
    if (agentWorktree() || teamContext()) throw new Error('team effects are applied only by the runner, outside agent worktrees');
    const { db, initSchema } = await import('../src/db.js');
    const { settleAgentReviews } = await import('../src/queue.js');
    initSchema();
    const context = read(file);
    result = command === 'apply-result' ? applyTeamResult(db, context, read(cap)) : settleAgentReviews(db, context);
  } else {
    throw new Error('usage: team.mjs show | validate FILE [MAX_AGENTS] | apply-result CONTEXT RESULT | settle-stage CONTEXT');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`team: ${error.message}`);
  process.exitCode = 1;
}
