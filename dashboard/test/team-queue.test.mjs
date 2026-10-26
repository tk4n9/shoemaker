// Team effects are applied by the runner, with the same database as the UI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'shoemaker-team-queue-'));
process.env.SHOEMAKER_STATE = dir;
process.env.SHOEMAKER_DB = join(dir, 'queue.db');
const { db, initSchema } = await import('../src/db.js');
const Q = await import('../src/queue.js');
const { applyTeamResult } = await import('../src/team-results.js');
const { readTeamSettings } = await import('../src/team-config.js');
initSchema();
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const reset = () => db.exec('DELETE FROM todos; DELETE FROM team_proposals');
const add = (title) => Q.addItem(db, { title });
const status = (id) => Q.getItem(db, id).status;
const context = (overrides = {}) => ({ run_id: 'round-1', stage_id: 'debate', role_id: 'reviewer', agent_id: 'reviewer-1',
  capabilities: ['review'], authority: 'advisory', max_waiting: 5, per_round: 3, ...overrides });
const vote = (id, agent, verdict = 'approve', authority = 'advisory', body = 'Worth building.') =>
  applyTeamResult(db, context({ agent_id: agent, authority }), { reviews: [{ id, verdict, body }] });
const settle = (reviewers) => Q.settleAgentReviews(db, { run_id: 'round-1', stage_id: 'debate', reviewers });
const roster = (authority, n = 3) => Array.from({ length: n }, (_, i) => ({ agent_id: `r${i}`, authority }));

test('schema migration adds team tables idempotently without moving queue items', () => {
  reset();
  const id = add('Existing waiting idea');
  initSchema(); initSchema();
  assert.equal(status(id), 'proposed');
  for (const table of ['agent_reviews', 'agent_review_decisions', 'team_proposals']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
});

test('dashboard cap agrees with the last literal assignment sourced by the runner', () => {
  writeFileSync(join(dir, 'shoemaker.conf'), 'MAX_AGENTS=16\nMAX_AGENTS="2" # local override\n');
  assert.equal(readTeamSettings(dir).maxAgents, 2);
  rmSync(join(dir, 'shoemaker.conf'));
  assert.equal(readTeamSettings(dir).maxAgents, 16);
});

test('advisory reviewers discuss with a persistent thread; human keeps authority', () => {
  reset();
  const id = add('Discuss this');
  vote(id, 'r0'); vote(id, 'r1', 'reject', 'advisory', 'This overlaps another idea.');
  vote(id, 'r0', 'abstain', 'advisory', 'Reply to r1: leave the overlap decision to the human.');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_reviews WHERE todo_id=?').get(id).n, 2);
  assert.match(Q.itemLog(db, id).at(-1).body, /Reply to r1/);
  const decisions = settle(roster('advisory', 2));
  assert.equal(decisions[0].authority, 'advisory');
  assert.equal(status(id), 'proposed');
  assert.deepEqual(settle(roster('advisory', 2)), []);
});

test('filter majority counts every stage reviewer, including missing votes', () => {
  reset();
  const id = add('Screening');
  vote(id, 'r0', 'reject', 'filter', 'Too broad.');
  vote(id, 'r1', 'reject', 'filter', 'Needs a narrower spec.');
  settle(roster('filter'));
  assert.equal(status(id), 'archived');
  assert.match(Q.getItem(db, id).status_note, /Too broad[\s\S]*narrower spec/);
  assert.match(Q.itemLog(db, id).at(-1).body, /filter authority; 2\/3/);
  const tied = add('Tie stays visible');
  vote(tied, 'r0', 'reject', 'filter');
  settle(roster('filter', 2));
  assert.equal(status(tied), 'proposed');
});

test('approve authority requires unanimous configured reviewers and no missing votes', () => {
  reset();
  const id = add('Unanimous');
  for (const r of roster('approve')) vote(id, r.agent_id, 'approve', 'approve');
  settle(roster('approve'));
  assert.equal(status(id), 'approved');
  assert.equal(Q.getItem(db, id).priority, 0);
  const missing = add('Missing reviewer');
  vote(missing, 'r0', 'approve', 'approve');
  settle(roster('approve', 2));
  assert.equal(status(missing), 'proposed');
});

test('mixed authority cannot silently promote advisory votes to approval', () => {
  reset();
  const id = add('Mixed');
  vote(id, 'r0', 'approve', 'approve'); vote(id, 'r1', 'approve', 'advisory');
  settle([{ agent_id: 'r0', authority: 'approve' }, { agent_id: 'r1', authority: 'advisory' }]);
  assert.equal(status(id), 'proposed');
});

test('review decisions never override a human action made during the stage', () => {
  reset();
  const id = add('Human acted');
  vote(id, 'r0', 'reject', 'filter');
  Q.approve(db, id, 1);
  settle(roster('filter', 1));
  assert.equal(status(id), 'approved');
  assert.equal(Q.getItem(db, id).priority, 1);
});

test('omitting a vote on a successful discussion turn clears earlier approval', () => {
  reset();
  const id = add('Reconsider');
  vote(id, 'r0', 'approve', 'approve');
  applyTeamResult(db, context({ agent_id: 'r0', authority: 'approve' }), {});
  settle(roster('approve', 1));
  assert.equal(status(id), 'proposed');
  assert.match(Q.itemLog(db, id).map((c) => c.body).join('\n'), /abstain: No verdict/);
});

test('proposal quota is shared across roles and survives screening or approval', () => {
  reset();
  const c = context({ capabilities: ['propose'], per_round: 2, max_waiting: 2 });
  const p = (title) => ({ title, body: '**Files:** `src/example.js`' });
  const first = applyTeamResult(db, c, { proposals: [p('First')] }).proposed[0];
  Q.archive(db, first, 'Already handled');
  db.prepare('DELETE FROM todos WHERE id = ?').run(first);
  const second = applyTeamResult(db, { ...c, agent_id: 'other' }, { proposals: [p('Second'), p('Third')] });
  assert.equal(second.proposed.length, 1);
  assert.equal(Q.loadState(db).items.length, 1);
  assert.equal(applyTeamResult(db, c, { proposals: [p('Fourth')] }).proposed.length, 0);
});

test('max_waiting is enforced transactionally even with many candidate proposals', () => {
  reset(); add('Existing');
  const result = applyTeamResult(db, context({ capabilities: ['propose'], max_waiting: 2 }), {
    proposals: [{ title: 'Fits', body: '' }, { title: 'Does not fit', body: '' }],
  });
  assert.equal(result.proposed.length, 1);
  assert.equal(Q.stats(db).proposed, 2);
});

test('capabilities, unknown output fields and invalid verdicts fail without partial writes', () => {
  reset();
  const id = add('Unchanged');
  assert.throws(() => applyTeamResult(db, context(), { proposals: [{ title: 'No', body: '' }] }), /lacks propose/);
  assert.throws(() => applyTeamResult(db, context(), { report: 'No report permission' }), /lacks report/);
  assert.throws(() => applyTeamResult(db, context(), { command: 'approve' }), /unknown field/);
  assert.throws(() => applyTeamResult(db, context({ capabilities: ['review', 'propose'] }), {
    proposals: [{ title: 'Must roll back', body: '' }], reviews: [{ id, verdict: 'maybe', body: 'No' }],
  }), /invalid review/);
  assert.equal(Q.stats(db).total, 1);
  assert.equal(status(id), 'proposed');
});

test('runner parses structured envelopes and returns read-only reports', () => {
  reset();
  assert.deepEqual(applyTeamResult(db, context({ capabilities: ['report'] }), {
    type: 'result', structured_output: { report: '# Analysis\nNo changes made.' },
  }), { proposed: [], reviewed: [], report: '# Analysis\nNo changes made.' });
  assert.throws(() => applyTeamResult(db, context(), { is_error: true }), /error/);
});

test('build queue context limits writes to its assigned item and keeps legacy exit codes', () => {
  reset();
  const id = add('Assigned'), other = add('Other');
  Q.approve(db, id, 2); Q.claim(db, id, 'round-1');
  const file = join(dir, 'context.json');
  writeFileSync(file, JSON.stringify(context({ capabilities: ['build'], item_id: id })));
  const cli = (args) => spawnSync(process.execPath, [new URL('../bin/queue.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, SHOEMAKER_TEAM_CONTEXT: file }, encoding: 'utf8',
  });
  assert.equal(cli(['note', String(id), 'Own item']).status, 0);
  assert.equal(cli(['note', String(other), 'Wrong item']).status, 1);
  assert.equal(cli(['add', '--title', 'Not permitted']).status, 1);
  assert.equal(cli(['show', String(other), '--json']).status, 0);
  assert.equal(cli(['approve', String(id)]).status, 1);
  const internal = spawnSync(process.execPath, [new URL('../bin/team.mjs', import.meta.url).pathname, 'settle-stage', file], {
    env: { ...process.env, SHOEMAKER_TEAM_CONTEXT: file }, encoding: 'utf8',
  });
  assert.equal(internal.status, 1);
  assert.match(internal.stderr, /only by the runner/);
});

test('later build stages can exclude earlier attempts without changing ordinary pick order', () => {
  reset();
  const a = add('First attempt'), b = add('New work');
  Q.approve(db, a, 1); Q.approve(db, b, 2);
  assert.equal(Q.pickMany(db, 'round-1', 1).items[0].item.id, a);
  assert.equal(Q.nextItems(db, 1).items[0].item.id, a);
  assert.equal(Q.pickMany(db, 'round-1', 1, 'runner', { exclude: [a] }).items[0].item.id, b);
});
