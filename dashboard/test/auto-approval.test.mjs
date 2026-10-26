// Auto-approval is a read-only worker; the runner applies its snapshot results.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'shoemaker-approval-'));
process.env.SHOEMAKER_DB = join(dir, 'queue.db');
process.env.SHOEMAKER_STATE = dir;
const { db, initSchema } = await import('../src/db.js');
const Q = await import('../src/queue.js');
const { applyTeamResult } = await import('../src/team-results.js');
initSchema();
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const reset = () => db.exec('DELETE FROM todos; UPDATE config SET auto_approve = 0');
const add = (title, deps = [], suggestedPriority = null) => Q.addItem(db, { title, deps, suggestedPriority, body: '**Files:** src/example.js\n**Tests:** npm test' });
const status = (id) => Q.getItem(db, id).status;
const snapshot = () => Q.approvalSnapshot(db).items;
const context = (items = snapshot(), run_id = 'round-1') => ({ run_id, stage_id: 'auto-approval', role_id: 'approve', agent_id: 'approve-1',
  capabilities: ['review'], authority: 'approve', auto_approval: true, per_round: 0, max_waiting: 0, items });
const vote = (id, verdict = 'approve', body = 'Fits the direction and has a buildable spec.') => ({ id, verdict, body });
const apply = (ctx, reviews) => applyTeamResult(db, ctx, { reviews });
const cli = (args, options = {}) => spawnSync(process.execPath, [new URL('../bin/queue.mjs', import.meta.url).pathname, ...args], {
  encoding: 'utf8', env: process.env, ...options,
});

test('migration defaults auto approval off and preserves the dashboard setting', () => {
  reset();
  assert.equal(Q.approvalSnapshot(db).enabled, false);
  db.prepare('UPDATE config SET auto_approve = 1').run();
  initSchema(); initSchema();
  assert.equal(Q.approvalSnapshot(db).enabled, true);
  const legacy = join(dir, 'legacy.db');
  const old = new Database(legacy);
  old.exec("CREATE TABLE config (id INTEGER PRIMARY KEY, project_name TEXT); INSERT INTO config VALUES (1, 'Legacy')");
  old.close();
  const migrated = cli(['approval', '--json'], { env: { ...process.env, SHOEMAKER_DB: legacy } });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.deepEqual(JSON.parse(migrated.stdout), { enabled: false, items: [] });
});

test('approvals only affect snapshot items still waiting, using Auto priority and an attributed reason', () => {
  reset();
  const approved = add('Suitable', [], 'high'), human = add('Human decided'), archived = add('Human rejected');
  const ctx = context();
  const late = add('Suggested during this round');
  Q.approve(db, human, 3); Q.archive(db, archived, 'No thanks');
  const result = apply(ctx, [approved, human, archived, late].map((id) => vote(id)));
  assert.deepEqual(result.approved, [approved]);
  assert.deepEqual([approved, human, archived, late].map(status), ['approved', 'approved', 'archived', 'proposed']);
  assert.equal(Q.getItem(db, approved).priority, 0);
  assert.equal(Q.loadState(db).byId.get(approved).effective_priority, 1);
  assert.equal(Q.getItem(db, human).priority, 3);
  const note = Q.itemLog(db, approved).at(-1);
  assert.equal(note.author, 'auto-approval agent');
  assert.match(note.body, /round round-1.*Auto \(High\).*Fits the direction/);
  assert.equal(db.prepare('SELECT verdict FROM agent_reviews WHERE todo_id = ?').get(approved).verdict, 'approve');
});

test('automatic approval without a recommendation uses Normal', () => {
  reset(); const id = add('No recommendation');
  apply(context(), [vote(id)]);
  assert.equal(Q.getItem(db, id).priority, 0);
  assert.equal(Q.loadState(db).byId.get(id).effective_priority, 2);
});

test('waiting prerequisites require approval in the same result, including transitive prerequisites', () => {
  reset();
  const a = add('Base'), b = add('Middle', [a]), c = add('Top', [b]);
  const result = apply(context(), [vote(b), vote(c)]);
  assert.deepEqual(result.approved, []);
  assert.deepEqual([a, b, c].map(status), ['proposed', 'proposed', 'proposed']);
  assert.match(Q.itemLog(db, b).at(-1).body, /waiting prerequisites/);
  Q.log(db, a, 'Scope clarified.'); Q.log(db, b, 'Scope clarified.'); Q.log(db, c, 'Scope clarified.');
  const together = apply(context(snapshot(), 'round-2'), [vote(c), vote(b), vote(a)]);
  assert.deepEqual(new Set(together.approved), new Set([a, b, c]));
});

test('a prerequisite changed by the human cannot be approved through a dependent', () => {
  reset(); const a = add('Base'), b = add('Dependent', [a]);
  const ctx = context();
  Q.approve(db, a, 1); Q.unapprove(db, a);
  apply(ctx, [vote(a), vote(b)]);
  assert.equal(status(a), 'proposed'); assert.equal(status(b), 'proposed');
});

test('approving a prerequisite reopens a dependent hold, including transitive blockers', () => {
  reset(); const a = add('Base'), b = add('Already approved middle', [a]), c = add('Held dependent', [b]);
  Q.approve(db, b, 0);
  apply(context(), [vote(c)]);
  assert.ok(!snapshot().some((t) => t.id === c));
  Q.approve(db, a, 0);
  assert.ok(snapshot().some((t) => t.id === c));
  apply(context(snapshot(), 'round-2'), [vote(c)]);
  assert.equal(status(c), 'approved');
});

test('human unapproval or restoration permanently excludes an item, even after edits', () => {
  reset(); const a = add('Sent back'), b = add('Restored');
  const ctx = context();
  Q.approve(db, a, 0); Q.unapprove(db, a);
  Q.archive(db, b); Q.restore(db, b);
  db.prepare('UPDATE todos SET explanation = ?').run('Changed spec');
  assert.deepEqual(snapshot(), []);
  assert.deepEqual(apply(ctx, [vote(a), vote(b)]).approved, []);
  assert.deepEqual([a, b].map(status), ['proposed', 'proposed']);
});

test('migration recognizes items returned to review before auto approval existed', () => {
  reset(); const a = add('Older returned idea');
  Q.log(db, a, 'Restored for review.');
  db.exec('ALTER TABLE todos DROP COLUMN auto_approval_blocked');
  initSchema();
  assert.equal(Q.getItem(db, a).auto_approval_blocked, 1);
  assert.deepEqual(snapshot(), []);
});

test('held items have one reason and no repeated notes until their input changes', () => {
  reset(); const id = add('Needs work');
  const ctx = context();
  apply(ctx, [vote(id, 'abstain', 'Tests need concrete assertions.')]);
  assert.equal(Q.itemLog(db, id).filter((n) => n.author === 'auto-approval agent').length, 1);
  const count = Q.itemLog(db, id).length;
  assert.deepEqual(snapshot(), []);
  apply({ ...ctx, run_id: 'round-2' }, [vote(id, 'abstain')]);
  assert.equal(Q.itemLog(db, id).length, count);
  Q.log(db, id, 'The human clarified the assertions.');
  assert.equal(snapshot()[0].id, id);
});

test('spec, title and prerequisite changes each make a held idea eligible again', () => {
  reset(); const dep = add('Dependency'), id = add('Held idea');
  for (const [i, edit] of [
    () => db.prepare('UPDATE todos SET explanation = ? WHERE id = ?').run('Better spec', id),
    () => db.prepare('UPDATE todos SET title = ? WHERE id = ?').run('Clearer title', id),
    () => Q.setDeps(db, id, [dep]),
  ].entries()) {
    apply(context(snapshot(), `round-${i}`), [vote(id, 'abstain', 'Needs clarification.')]);
    assert.ok(!snapshot().some((t) => t.id === id));
    edit();
    assert.ok(snapshot().some((t) => t.id === id));
  }
});

test('a new team note reopens a hold, while a mid-round edit defers approval', () => {
  reset(); const id = add('Clarify before approval');
  apply(context(), [vote(id, 'abstain')]);
  Q.agentReview(db, id, { run_id: 'review-round', stage_id: 'team', role_id: 'r', agent_id: 'r-1', authority: 'advisory', verdict: 'approve', body: 'The missing assertion is described here.' });
  const ctx = context(snapshot(), 'round-2');
  assert.equal(ctx.items[0].id, id);
  Q.log(db, id, 'New constraint during this round.');
  const result = apply(ctx, [vote(id)]);
  assert.deepEqual(result.skipped, [id]);
  assert.equal(status(id), 'proposed');
  assert.equal(snapshot()[0].id, id);
});

test('a missing verdict decides nothing and a rejection only holds', () => {
  reset(); const id = add('Missing verdict'), other = add('No rejection authority');
  const notes = Q.itemLog(db, id).length;
  const result = apply(context(), [vote(other, 'reject', 'Out of scope.')]);
  assert.deepEqual(result.skipped, [id]);
  assert.deepEqual(result.held, [other]);
  assert.equal(Q.itemLog(db, id).length, notes);
  assert.deepEqual([id, other].map(status), ['proposed', 'proposed']);
  assert.match(Q.itemLog(db, other).at(-1).body, /Held for human review.*Out of scope/);
  assert.equal(db.prepare('SELECT verdict FROM agent_reviews WHERE todo_id = ?').get(other).verdict, 'abstain');
  assert.deepEqual(snapshot().map((t) => t.id), [id]);
});

test('team reviewer notes written during the round do not void an approval', () => {
  reset(); const id = add('Reviewed in parallel');
  const ctx = context();
  Q.agentReview(db, id, { run_id: 'round-1', stage_id: 'review', role_id: 'r', agent_id: 'r-1', authority: 'advisory', verdict: 'approve', body: 'Worth building.' });
  assert.deepEqual(apply(ctx, [vote(id)]).approved, [id]);
});

test('queue CLI exposes mode and snapshot read-only with no approval or setting path', () => {
  reset(); const id = add('CLI visible');
  const read = cli(['approval', '--json']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).items[0].id, id);
  for (const args of [['approval', 'on'], ['approval', '--auto-approve', 'true'], ['approval', '--status', 'on'], ['config', 'auto_approve', 'true'], ['approve', String(id)]]) {
    assert.equal(cli(args).status, 2, args.join(' '));
  }
  assert.equal(Q.approvalSnapshot(db).enabled, false);
  assert.equal(status(id), 'proposed');
});

test('runner result application is refused from both team and default agent worktrees', () => {
  reset(); const id = add('Guarded');
  const ctx = join(dir, 'context.json'), result = join(dir, 'result.json');
  writeFileSync(ctx, JSON.stringify(context())); writeFileSync(result, JSON.stringify({ reviews: [vote(id)] }));
  const command = [new URL('../bin/team.mjs', import.meta.url).pathname, 'apply-result', ctx, result];
  const team = spawnSync(process.execPath, command, { encoding: 'utf8', env: { ...process.env, SHOEMAKER_TEAM_CONTEXT: ctx } });
  assert.equal(team.status, 1); assert.match(team.stderr, /only by the runner/);
  const worktree = join(dir, 'default-agent'); mkdirSync(worktree);
  assert.equal(spawnSync('git', ['init', '-q', worktree]).status, 0);
  assert.equal(spawnSync('git', ['-C', worktree, 'config', 'shoemaker.role', 'suggest']).status, 0);
  const defaultAgent = spawnSync(process.execPath, command, { cwd: worktree, env: process.env, encoding: 'utf8' });
  assert.equal(defaultAgent.status, 1); assert.match(defaultAgent.stderr, /only by the runner/);
  assert.equal(status(id), 'proposed');
});
