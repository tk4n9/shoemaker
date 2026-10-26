// The agent queue's rules (src/queue.js) and the agents' CLI (bin/queue.mjs),
// against an isolated temp DB. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'shoemaker-queue-'));
delete process.env.SHOEMAKER_STATE;
process.env.SHOEMAKER_DB = join(dir, 'queue.db');
const { db, initSchema } = await import('../src/db.js');
const Q = await import('../src/queue.js');
initSchema();

const CLI = new URL('../bin/queue.mjs', import.meta.url).pathname;
const cli = (args, { input, dbPath = process.env.SHOEMAKER_DB, author = 'test agent' } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input, encoding: 'utf8', env: { ...process.env, SHOEMAKER_DB: dbPath, SHOEMAKER_AUTHOR: author },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const fresh = () => db.exec('DELETE FROM comments; DELETE FROM todo_deps; DELETE FROM todos;');
const add = (title, deps = []) => Q.addItem(db, { title, deps, source: 'suggestion agent', author: 'test' });
const status = (id) => Q.getItem(db, id).status;

test('an approved item waits until every prerequisite has shipped', () => {
  fresh();
  const a = add('A');
  const b = add('B');
  const c = add('C', [a, b]);
  Q.approve(db, c, 2);
  let next = Q.nextItem(db);
  assert.equal(next.item, null);
  assert.match(next.why, new RegExp(`#${c} needs #${a} \\(not approved yet\\), #${b} \\(not approved yet\\)`));
  Q.approve(db, a, 2);
  Q.approve(db, b, 2);
  assert.equal(Q.nextItem(db).item.id, a);
  Q.claim(db, a, 'r1');
  Q.ship(db, a, { pr: 'https://gitlab.example.com/acme/app/-/merge_requests/7' });
  assert.equal(Q.nextItem(db).item.id, b);   // C still needs B
  Q.claim(db, b, 'r2');
  Q.ship(db, b);
  assert.equal(Q.nextItem(db).item.id, c);
  assert.equal(Q.loadState(db).byId.get(c).ready, true);
});

test('a prerequisite inherits the priority of approved work that needs it', () => {
  fresh();
  const other = add('Unrelated, normal');
  const base = add('Base, low');
  const top = add('Top, high', [base]);
  Q.approve(db, other, 2);
  Q.approve(db, base, 3);
  Q.approve(db, top, 1);
  const state = Q.loadState(db);
  assert.equal(state.byId.get(base).effective_priority, 1);
  assert.equal(Q.nextItem(db).item.id, base);   // pulled ahead of the Normal item by Top
});

test('Auto priority uses the suggested priority, else Normal', () => {
  fresh();
  const normal = Q.addItem(db, { title: 'Yours, no suggestion' });
  const high = Q.addItem(db, { title: 'Suggested high', source: 'suggestion agent', suggestedPriority: 'high' });
  const low = Q.addItem(db, { title: 'Suggested low', source: 'suggestion agent', suggestedPriority: 'low' });
  assert.equal(Q.getItem(db, high).priority, 0);   // nothing is chosen until you approve
  Q.approve(db, low, 'auto');
  Q.approve(db, normal, 0);
  Q.approve(db, high, 0);
  const state = Q.loadState(db);
  assert.deepEqual([low, normal, high].map((id) => state.byId.get(id).effective_priority), [3, 2, 1]);
  assert.equal(Q.priorityWords(state.byId.get(high)), 'Auto (High)');
  assert.equal(Q.nextItem(db).item.id, high);
  Q.setPriority(db, low, 'high');                  // your choice overrides the suggestion
  assert.equal(Q.loadState(db).byId.get(low).effective_priority, 1);
  assert.match(Q.itemLog(db, high).map((c) => c.body).join('\n'), /at High priority[\s\S]*Approved, priority Auto \(High\)/);
  assert.throws(() => Q.addItem(db, { title: 'x', suggestedPriority: 'auto' }), /high, normal or low/);
  assert.throws(() => Q.approve(db, normal, 'urgent'), /auto, high, normal or low/);
});

test('an Auto prerequisite inherits from Auto work that needs it', () => {
  fresh();
  const base = Q.addItem(db, { title: 'Base', source: 'suggestion agent', suggestedPriority: 'low' });
  const top = Q.addItem(db, { title: 'Top', deps: [base], source: 'suggestion agent', suggestedPriority: 'high' });
  Q.approve(db, top, 0, { withPrereqs: true });
  assert.equal(Q.loadState(db).byId.get(base).effective_priority, 1);
});

test('within a priority, the first approved goes first', () => {
  fresh();
  const x = add('X');
  const y = add('Y');
  Q.approve(db, y, 2);
  db.prepare("UPDATE todos SET approved_at = '2000-01-01 00:00:00' WHERE id = ?").run(y);
  Q.approve(db, x, 2);
  assert.equal(Q.nextItem(db).item.id, y);
  Q.setPriority(db, x, 1);
  assert.equal(Q.nextItem(db).item.id, x);
});

test('several builds at once never share a file their specs name', () => {
  fresh();
  const spec = (files) => `**Problem:** x\n\n**Files:** ${files}\n`;
  const site1 = Q.addItem(db, { title: 'Site 1', body: spec('`site/index.html`, `site/README.md`') });
  const site2 = Q.addItem(db, { title: 'Site 2', body: spec('`site/index.html`') });
  const dash = Q.addItem(db, { title: 'Dash', body: spec('`dashboard/src/rules.js` (the list)') });
  const folder = Q.addItem(db, { title: 'Folder', body: spec('`dashboard/src/`') });
  const loose = Q.addItem(db, { title: 'No files line' });
  for (const id of [site1, site2, dash, folder, loose]) Q.approve(db, id, 2);
  assert.deepEqual(Q.specFiles(Q.getItem(db, site1)), ['site/index.html', 'site/README.md']);
  const wrapped = { explanation: '**Change.** edit `x.js`\n\n**Files.** `dashboard/public/js/home.js` (`renderTopStatus`), `dashboard/public/index.html`\n(the intro), `dashboard/public/app.css` (`white-space: nowrap`),\n`docs/design/ui/dashboard.md`.\n**Tests.** `tests/a.test.js`\n' };
  assert.deepEqual(Q.specFiles(wrapped), ['dashboard/public/js/home.js', 'dashboard/public/index.html', 'dashboard/public/app.css', 'docs/design/ui/dashboard.md']);
  assert.deepEqual(Q.specFiles({ explanation: '## Files\n- `a/b.ts`\n- `c/`\n\n## Tests\n`t/x.mjs`' }), ['a/b.ts', 'c']);
  assert.deepEqual(Q.specFiles({ explanation: '**Files.**\n\n- `x/index.html:111`: an id\n- `x/app.css`: `setPage`\n\n**Tests.**\n- `t/y.mjs`' }), ['x/index.html', 'x/app.css']);
  assert.deepEqual(Q.nextItems(db, 5).items.map((c) => c.item.id), [site1, dash, loose]);
  assert.deepEqual(Q.nextItems(db, 2).items.map((c) => c.item.id), [site1, dash]);
  const r = cli(['pick', '--run', 'r1', '--max', '5', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).items.map((c) => c.item.id), [site1, dash, loose]);
  assert.deepEqual([site1, site2, dash, folder, loose].map(status), ['in_progress', 'approved', 'in_progress', 'approved', 'in_progress']);
  // the next round resumes the started ones first and adds what no longer overlaps
  assert.deepEqual(Q.nextItems(db, 5).items.map((c) => [c.item.id, c.resume]), [[site1, true], [dash, true], [loose, true]]);
  Q.ship(db, dash);
  assert.deepEqual(Q.nextItems(db, 5).items.map((c) => c.item.id), [site1, loose, folder]);
  const none = cli(['next', '--max', '2', '--json'], {});
  assert.equal(none.code, 0);
  assert.equal(cli(['pick', '--run', 'r2', '--max', '0']).code, 2);
});

test('a started item is resumed first, and failed after its last attempt', () => {
  fresh();
  const a = add('Hard one');
  const b = add('Easy one');
  Q.approve(db, a, 1);
  Q.approve(db, b, 2);
  for (let round = 1; round <= Q.MAX_ATTEMPTS; round++) {
    const picked = Q.pick(db, `r${round}`);
    assert.equal(picked.item.id, a);
    assert.equal(picked.resume, round > 1);
    assert.equal(picked.item.attempts, round);
  }
  const after = Q.pick(db, 'r4');
  assert.equal(status(a), 'failed');
  assert.match(Q.getItem(db, a).status_note, /gave up after 3 rounds/);
  assert.equal(after.item.id, b);
  Q.retry(db, a);
  assert.equal(status(a), 'approved');
  assert.equal(Q.getItem(db, a).attempts, 0);
});

test('agents cannot skip the human: no claim before approval, no shipping a proposal', () => {
  fresh();
  const a = add('Not approved');
  assert.throws(() => Q.claim(db, a, 'r1'), /only an approved or started item/);
  assert.throws(() => Q.ship(db, a), /only an item in progress or waiting for a merge can ship/);
  assert.throws(() => Q.fail(db, a, 'x'), /cannot become failed/);
  const b = add('Approved but blocked', [a]);
  Q.approve(db, b, 2);
  assert.throws(() => Q.claim(db, b, 'r1'), /still needs #\d+ \(not approved yet\)/);
});

test('an agent ships only the item it works on; the runner records a late merge', () => {
  fresh();
  const base = add('Base, not approved');
  const top = add('Top, approved but blocked', [base]);
  Q.approve(db, top, 2);
  assert.throws(() => Q.ship(db, top), /only an item in progress or waiting for a merge can ship/);
  assert.equal(Q.loadState(db).byId.get(top).ready, false);   // its prerequisite was not shipped around the human
  const c = add('Gave up, merged later');
  Q.approve(db, c, 2);
  Q.claim(db, c, 'r1');
  Q.setLinks(db, c, { pr: 'https://gitlab.example.com/acme/app/-/merge_requests/41' });
  Q.fail(db, c, 'gave up after 3 rounds');
  assert.throws(() => Q.ship(db, c), /only an item in progress/);
  Q.merged(db, c, {}, 'run.sh');
  assert.equal(status(c), 'shipped');
  assert.match(Q.itemLog(db, c).at(-1).body, /^Merged: https:\/\/gitlab\.example\.com\/acme\/app\/-\/merge_requests\/41/);
  assert.throws(() => Q.merged(db, base), /its merge cannot be recorded/);
});

test('an attempt the agent never used is given back', () => {
  fresh();
  const a = add('Usage limit hit');
  Q.approve(db, a, 2);
  Q.pick(db, 'r1');
  Q.release(db, a, 'claude exited 1 at once (usage limit)');
  assert.deepEqual([status(a), Q.getItem(db, a).attempts], ['approved', 0]);
  Q.pick(db, 'r2');
  Q.setLinks(db, a, { branch: 'shoemaker/q1-x' });
  Q.pick(db, 'r3');                                       // resumed: attempt 2
  Q.release(db, a, 'claude exited 1 at once');
  assert.deepEqual([status(a), Q.getItem(db, a).attempts], ['in_progress', 1]);   // work on its branch stays in progress
  assert.throws(() => Q.release(db, a, ''), /say why/);
});

test('retry and restore start afresh: the old branch and PR move into the log', () => {
  fresh();
  const a = add('Closed PR');
  Q.approve(db, a, 1);
  Q.claim(db, a, 'r1');
  Q.setLinks(db, a, { branch: 'shoemaker/q1-old', pr: 'https://github.com/acme/app/pull/10' });
  Q.fail(db, a, 'its pull request #10 was closed without merging');
  Q.retry(db, a);
  const t = Q.getItem(db, a);
  assert.deepEqual([t.status, t.branch, t.pr_url, t.attempts], ['approved', null, null, 0]);
  assert.ok(Q.itemLog(db, a).some((c) => c.body.startsWith('Earlier attempt: branch shoemaker/q1-old, pull request https://github.com/acme/app/pull/10.')));
  Q.claim(db, a, 'r2');
  Q.archive(db, a, 'changed my mind');
  Q.restore(db, a);
  assert.deepEqual([status(a), Q.getItem(db, a).attempts], ['proposed', 0]);
});

test('pull request links must be web addresses', () => {
  fresh();
  const a = add('Links');
  Q.approve(db, a, 2);
  Q.claim(db, a, 'r1');
  assert.throws(() => Q.setLinks(db, a, { pr: 'javascript:alert(1)' }), /not a web address/);
  assert.throws(() => Q.toReview(db, a, 'data:text/html,x'), /not a web address/);
  assert.throws(() => Q.ship(db, a, { pr: 'javascript:x' }), /not a web address/);
  Q.setLinks(db, a, { pr: 'http://gitlab.example.com/acme/app/-/merge_requests/3' });
});

test('a pull request link has a short name from its host', () => {
  assert.equal(Q.prName('https://github.com/acme/app/pull/3'), '#3');
  assert.equal(Q.prName('https://gitlab.example.com/acme/app/-/merge_requests/3'), '!3');
  assert.equal(Q.prName('https://git.example.com/acme/app/changes/3'), 'PR');
});

test('adding refuses unknown, archived and duplicate prerequisites or titles', () => {
  fresh();
  const a = add('Exists');
  assert.throws(() => add('Bad dep', [999]), /no item #999/);
  Q.archive(db, a, 'nope');
  assert.throws(() => add('On archived', [a]), /archived/);
  assert.throws(() => add('exists'), /already has this title/);
  assert.equal(Q.getItem(db, a).status_note, 'nope');
});

test('every move is written to the item log', () => {
  fresh();
  const a = add('Logged');
  Q.approve(db, a, 1);
  Q.claim(db, a, 'run-7', 'implementation agent');
  Q.setLinks(db, a, { branch: 'shoemaker/q1-x', pr: 'https://github.com/acme/app/pull/1' });
  Q.toReview(db, a, null);
  Q.ship(db, a, { note: 'merged by the human' }, 'run.sh');
  const lines = Q.itemLog(db, a).map((c) => `${c.author}: ${c.body}`);
  assert.deepEqual(lines, [
    'test: Suggested by the suggestion agent.',
    'you: Approved, priority High.',
    'implementation agent: Picked up by run run-7 (attempt 1 of 3).',
    'agent: Branch: shoemaker/q1-x',
    'agent: Pull request: https://github.com/acme/app/pull/1',
    'agent: Draft pull request waiting for your merge.',
    'run.sh: Shipped: https://github.com/acme/app/pull/1 merged by the human',
  ]);
});

test('CLI: add, list, show, next and the implementation round', () => {
  fresh();
  const spec = join(dir, 'idea.md');
  writeFileSync(spec, '## Problem\nThe save bar scrolls away.\n');
  const first = cli(['add', '--title', 'Pin the save bar', '--body-file', spec, '--run', '2026-10-17-1130', '--json']);
  assert.equal(first.code, 0, first.err);
  const id = JSON.parse(first.out).id;
  const second = cli(['add', '--title', 'Show the count on the bar', '--deps', String(id), '--body-file', '-'], { input: 'spec on stdin' });
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /^added #\d+/);

  const list = cli(['list']);
  assert.match(list.out, new RegExp(`#${id} waiting for review — Pin the save bar`));
  assert.match(list.out, new RegExp(`Show the count on the bar — needs #${id} \\(waiting for review\\)`));
  const shown = JSON.parse(cli(['show', String(id), '--json']).out);
  assert.equal(shown.spec, '## Problem\nThe save bar scrolls away.\n');
  assert.equal(shown.source, 'test agent');
  assert.equal(shown.run_id, '2026-10-17-1130');

  const none = cli(['next']);
  assert.equal(none.code, 3);
  assert.match(none.out, /nothing to build: nothing is approved; 2 waiting for your review/);

  Q.approve(db, id, 2);   // the human, on the page
  const picked = cli(['pick', '--run', 'r1', '--json']);
  assert.equal(picked.code, 0, picked.err);
  const item = JSON.parse(picked.out);
  assert.equal(item.item.id, id);
  assert.equal(item.item.status, 'in_progress');
  assert.equal(item.resume, false);
  assert.equal(cli(['set', String(id), '--branch', 'shoemaker/q1-pin', '--pr', 'https://github.com/acme/app/pull/9']).code, 0);
  assert.equal(JSON.parse(cli(['show', String(id), '--json']).out).pr_url, 'https://github.com/acme/app/pull/9');
  assert.equal(cli(['note', String(id), 'pipeline', 'running']).code, 0);
  assert.equal(cli(['ship', String(id), '--note', 'merged as abc123']).code, 0);
  assert.equal(status(id), 'shipped');
  assert.equal(Q.getItem(db, id).pr_url, 'https://github.com/acme/app/pull/9');
  const stats = JSON.parse(cli(['stats', '--json']).out);
  assert.equal(stats.shipped, 1);
  assert.equal(stats.proposed, 1);
});

test('CLI: refusals exit 1 with the reason; the human-only moves do not exist', () => {
  fresh();
  const a = add('Refusals');
  const r = cli(['claim', String(a), '--run', 'r1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /queue: #\d+ is waiting for your review; only an approved or started item can be picked up/);
  assert.equal(cli(['fail', String(a)]).code, 1);   // no reason given
  assert.equal(cli(['merged', String(a)]).code, 1);   // not in progress, waiting for a merge, or failed
  for (const cmd of ['approve', 'reject', 'priority', 'archive', 'restore', 'retry', 'unapprove']) {
    const out = cli([cmd, String(a)]);
    assert.equal(out.code, 2, `${cmd} should not exist`);
    assert.match(out.err, /unknown command/);
  }
  assert.equal(cli(['list', '--status', 'bogus']).code, 2);
});

test('an existing pre-queue database migrates without approving anything', () => {
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`
    CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), project_name TEXT NOT NULL DEFAULT 'My Project',
      show_completed INTEGER NOT NULL DEFAULT 1, theme TEXT NOT NULL DEFAULT 'light');
    CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      explanation TEXT NOT NULL DEFAULT '', due_date TEXT, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO config (id) VALUES (1);
    INSERT INTO todos (title, done) VALUES ('old open', 0), ('old done', 1);
    INSERT INTO comments (todo_id, body) VALUES (1, 'old note');`);
  old.close();
  const listed = cli(['list', '--json'], { dbPath: path });
  assert.equal(listed.code, 0, listed.err);
  const items = JSON.parse(listed.out);
  assert.deepEqual(items.map((t) => [t.title, t.status]), [['old open', 'proposed'], ['old done', 'shipped']]);
  const shown = JSON.parse(cli(['show', '1', '--json'], { dbPath: path }).out);
  assert.deepEqual(shown.log.map((c) => [c.by, c.text]), [['you', 'old note']]);
  assert.equal(cli(['next'], { dbPath: path }).code, 3);
  assert.equal(items[0].priority, 0);   // waiting for review: Auto until you choose
});

test('CLI: an unknown or mangled option is refused, not ignored', () => {
  fresh();
  const r = cli(['add', '--title', 'X', '--deps 3']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --deps 3/);
  assert.equal(cli(['list', '--jsn']).code, 2);
  assert.equal(Q.loadState(db).items.length, 0);
});

test('CLI: add --priority is a recommendation, shown in list and show', () => {
  fresh();
  const r = cli(['add', '--title', 'Recommended high', '--priority', 'high', '--json']);
  assert.equal(r.code, 0, r.err);
  const { id } = JSON.parse(r.out);
  assert.equal(Q.getItem(db, id).priority, 0);
  assert.equal(Q.getItem(db, id).suggested_priority, 1);
  assert.match(cli(['show', String(id)]).out, /suggested priority: High/);
  const bad = cli(['add', '--title', 'Bad', '--priority', 'auto']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /high, normal or low/);
  Q.approve(db, id, 0);
  assert.match(cli(['list']).out, /approved, Auto \(High\), ready/);
});

test('CLI: --mr is another name for --pr, and JSON says pr_url', () => {
  fresh();
  const a = add('Alias');
  Q.approve(db, a, 2);
  Q.claim(db, a, 'r1');
  const gl = 'https://gitlab.example.com/acme/app/-/merge_requests/3';
  assert.equal(cli(['set', String(a), '--mr', gl]).code, 0);
  assert.equal(Q.getItem(db, a).pr_url, gl);
  assert.equal(cli(['review', String(a), '--pr', 'https://github.com/acme/app/pull/3']).code, 0);
  const [item] = JSON.parse(cli(['list', '--json']).out);
  assert.equal(item.pr_url, 'https://github.com/acme/app/pull/3');
  assert.equal('mr_url' in item, false);
  assert.match(cli(['show', String(a)]).out, /^pull request: https:\/\/github\.com\/acme\/app\/pull\/3$/m);
  assert.equal(cli(['set', String(a)]).code, 2);   // needs --branch and/or --pr
});

test('CLI: log entries are written by $SHOEMAKER_AUTHOR, or --by', () => {
  fresh();
  const a = add('Authors');
  assert.equal(cli(['note', String(a), 'from the env'], { author: 'run.sh' }).code, 0);
  assert.equal(cli(['note', String(a), 'from the flag', '--by', 'suggestion agent'], { author: 'run.sh' }).code, 0);
  const r = spawnSync(process.execPath, [CLI, 'note', String(a), 'by default'], {
    encoding: 'utf8', env: { ...process.env, SHOEMAKER_DB: process.env.SHOEMAKER_DB, SHOEMAKER_AUTHOR: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Q.itemLog(db, a).slice(1).map((c) => [c.author, c.body]),
    [['run.sh', 'from the env'], ['suggestion agent', 'from the flag'], ['agent', 'by default']]);
});

test('CLI: SHOEMAKER_STATE holds queue.db; SHOEMAKER_DB overrides it', () => {
  const state = mkdtempSync(join(dir, 'state-'));
  const env = { ...process.env, SHOEMAKER_STATE: state };
  delete env.SHOEMAKER_DB;
  const r = spawnSync(process.execPath, [CLI, 'add', '--title', 'In the state dir', '--json'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const inState = new Database(join(state, 'queue.db'), { readonly: true });
  assert.deepEqual(inState.prepare('SELECT title FROM todos').all().map((t) => t.title), ['In the state dir']);
  inState.close();
  const other = join(dir, 'override.db');
  const o = spawnSync(process.execPath, [CLI, 'stats', '--json'], { encoding: 'utf8', env: { ...env, SHOEMAKER_DB: other } });
  assert.equal(o.status, 0, o.stderr);
  assert.equal(JSON.parse(o.stdout).total, 0);
});

test('a project-dashboard database: mr_url becomes pr_url, links kept', () => {
  const path = join(dir, 'mr.db');
  const old = new Database(path);
  old.exec(`
    CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), project_name TEXT NOT NULL DEFAULT 'My Project',
      show_completed INTEGER NOT NULL DEFAULT 1, theme TEXT NOT NULL DEFAULT 'light');
    CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      explanation TEXT NOT NULL DEFAULT '', due_date TEXT, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'proposed', mr_url TEXT);
    INSERT INTO config (id) VALUES (1);
    INSERT INTO todos (title, done, status, mr_url) VALUES
      ('Shipped before the rename', 1, 'shipped', 'https://gitlab.example.com/acme/app/-/merge_requests/3');`);
  old.close();
  const listed = cli(['list', '--json'], { dbPath: path });
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(JSON.parse(listed.out).map((t) => [t.title, t.pr_url]),
    [['Shipped before the rename', 'https://gitlab.example.com/acme/app/-/merge_requests/3']]);
  const migrated = new Database(path, { readonly: true });
  const cols = migrated.prepare('PRAGMA table_info(todos)').all().map((c) => c.name);
  migrated.close();
  assert.ok(cols.includes('pr_url'));
  assert.ok(!cols.includes('mr_url'));
  assert.equal(cli(['list'], { dbPath: path }).code, 0);   // a second open is a no-op
});
