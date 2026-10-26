// Smoke tests: boot the real server against an isolated temp DB/config and
// exercise the HTTP surface. Zero dependencies (node:test + global fetch).
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate state BEFORE importing the app (config.js/db.js read these at import):
// a state directory as `shoemaker init` writes it.
const dir = mkdtempSync(join(tmpdir(), 'shoemaker-test-'));
delete process.env.SHOEMAKER_DB;
delete process.env.SHOEMAKER_DASHBOARD_CONFIG;
process.env.SHOEMAKER_STATE = dir;
writeFileSync(join(dir, 'dashboard.json'), JSON.stringify({
  host: '127.0.0.1', port: 0, password: '', secret: 'test-secret', project: 'Acme App',
}));

const { createServer } = await import('../src/server.js');
const { db, DB_PATH } = await import('../src/db.js');

let server;
let base;
const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const page = async (path) => (await fetch(base + path)).text();
const add = async (title) => (await (await post('/todos', { title })).json()).id;
const status = (id) => db.prepare('SELECT status FROM todos WHERE id = ?').get(id)?.status;

before(async () => {
  server = await createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('dashboard is the home page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /class="appnav"/);
  assert.match(html, />Dashboard</);
  assert.match(html, /<dt>Last 24 hours<\/dt>/);
  assert.match(html, /<dt>Next round<\/dt>/);
  assert.match(html, /Your turn/);
});

test('SHOEMAKER_STATE holds the queue, and dashboard.json names a new one', async () => {
  assert.equal(DB_PATH, join(dir, 'queue.db'));
  assert.match(await page('/'), /value="Acme App"/);
  await post('/config', { project_name: 'Named on the page' });
  await createServer();   // a restart keeps the name chosen on the page
  assert.match(await page('/'), /value="Named on the page"/);
  await post('/config', { project_name: 'Acme App' });
});

test('todos list lives at /todos and says what the next round does', async () => {
  const res = await fetch(base + '/todos');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, />Todos</);
  assert.match(html, /Your turn/);
  assert.match(html, /Agents’ turn/);
  assert.match(html, /Next round:/);
});

test('Todos header toggles persisted auto approval through config with switch semantics', async () => {
  assert.equal(db.prepare('SELECT auto_approve FROM config WHERE id = 1').get().auto_approve, 0);
  const initial = await page('/todos');
  assert.match(initial, /id="toggle-auto-approve"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.equal((await post('/config', { auto_approve: true })).status, 200);
  assert.equal(db.prepare('SELECT auto_approve FROM config WHERE id = 1').get().auto_approve, 1);
  assert.match(await page('/todos'), /id="toggle-auto-approve"[^>]*role="switch"[^>]*aria-checked="true"/);
  assert.doesNotMatch(await page('/'), /id="toggle-auto-approve"/);
  assert.equal((await post('/config', { auto_approve: 'false' })).status, 400);
  assert.equal(db.prepare('SELECT auto_approve FROM config WHERE id = 1').get().auto_approve, 1);
  assert.equal((await post('/config', { auto_approve: false })).status, 200);
  assert.match(await page('/todos'), /id="toggle-auto-approve"[^>]*aria-checked="false"/);
});

test('unknown route is 404', async () => {
  const res = await fetch(base + '/does-not-exist');
  assert.equal(res.status, 404);
});

test('a new todo waits for review and offers approve / reject', async () => {
  const id = await add('Write tests');
  assert.equal(status(id), 'proposed');
  const html = await page(`/todos/${id}`);
  assert.match(html, /Write tests/);
  assert.match(html, new RegExp(`class="tag yours">#${id}<`));   // yellow: your turn
  assert.match(html, /To review/);
  assert.match(html, /data-action="approve"/);
  assert.match(html, /data-action="reject"/);
});

test('todo title is editable', async () => {
  const id = await add('Old title');
  assert.match(await page(`/todos/${id}`), /<textarea id="todo-title" class="detail-title" rows="1"[^>]*>Old title<\/textarea>/);
  const res = await post(`/todos/${id}/title`, { title: 'New title' });
  assert.equal(res.status, 200);
  assert.match(await page(`/todos/${id}`), /New title/);
  // empty, too long, or another item's title: rejected
  assert.equal((await post(`/todos/${id}/title`, { title: '  ' })).status, 400);
  assert.equal((await post(`/todos/${id}/title`, { title: 'x'.repeat(201) })).status, 400);
  await add('Taken title');
  assert.equal((await post(`/todos/${id}/title`, { title: 'taken TITLE' })).status, 400);
});

test('changes from another site are refused', async () => {
  const id = await add('Guarded');
  const form = await fetch(`${base}/todos/${id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'priority=1',
  });
  assert.equal(form.status, 403);
  const foreign = await fetch(`${base}/todos/${id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:9999' }, body: '{"priority":1}',
  });
  assert.equal(foreign.status, 403);
  assert.equal(status(id), 'proposed');
  const own = await fetch(`${base}/todos/${id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"priority":1}',
  });
  assert.equal(own.status, 200);
  assert.equal(status(id), 'approved');
  await post(`/todos/${id}/unapprove`, {});   // leave the queue as other tests expect it
  // the login form stays a plain form
  assert.notEqual((await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' })).status, 403);
});

test('add, render, and delete a comment', async () => {
  const id = await add('Has comments');
  const added = await (await post(`/todos/${id}/comments`, { body: 'first log entry' })).json();
  assert.equal(added.ok, true);
  assert.match(await page(`/todos/${id}`), /first log entry/);
  assert.equal((await post(`/todos/${id}/comments`, { body: '  ' })).status, 400); // empty rejected
  // edit
  assert.equal((await post(`/comments/${added.id}`, { body: 'edited entry' })).status, 200);
  assert.match(await page(`/todos/${id}`), /edited entry/);
  assert.equal((await post(`/comments/${added.id}`, { body: '  ' })).status, 400); // empty edit rejected
  assert.equal((await post(`/comments/${added.id}/delete`, {})).status, 200);
  assert.doesNotMatch(await page(`/todos/${id}`), /first log entry/);
});

test('your own idea: Add waits for review, Add & approve queues it', async () => {
  const waiting = await add('My idea, to review');
  assert.equal(status(waiting), 'proposed');
  const res = await post('/todos', { title: 'My idea, approved now', approve: true, priority: 1 });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const row = db.prepare('SELECT status, priority, source FROM todos WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { status: 'approved', priority: 1, source: 'you' });
  assert.match(await page('/todos'), /Add &amp; approve/);
  // a refused approval leaves nothing behind
  assert.equal((await post('/todos', { title: 'Bad priority', approve: true, priority: 9 })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos WHERE title = 'Bad priority'").get().n, 0);
  await post(`/todos/${id}/unapprove`, {});
});

test('add requires a title and refuses a duplicate', async () => {
  assert.equal((await post('/todos', { title: '   ' })).status, 400);
  await add('Only once');
  const dup = await post('/todos', { title: 'only once' });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /already has this title/);
});

test('there are no due dates', async () => {
  const id = await add('No due date');
  assert.equal((await post(`/todos/${id}/due`, { due_date: '2030-01-01' })).status, 404);
  assert.doesNotMatch(await page(`/todos/${id}`), /due-date|Due:/);
  assert.doesNotMatch(await page('/'), /Due soon/);
});

test('a pull request shows by its short name', async () => {
  const Q = await import('../src/queue.js');
  const id = await add('Has a pull request');
  await post(`/todos/${id}/approve`, { priority: 1 });
  Q.claim(db, id, 'r1');
  Q.setLinks(db, id, { pr: 'https://github.com/acme/app/pull/3' });
  assert.match(await page('/todos'), /<a class="pr" href="https:\/\/github\.com\/acme\/app\/pull\/3"[^>]*>#3<\/a>/);
  assert.match(await page(`/todos/${id}`), /<dt>Pull request<\/dt>/);
  assert.match(await page('/'), />#3<\/a>/);
  Q.archive(db, id, 'test done');
});

test('config update is reflected on the page', async () => {
  await post('/config', { project_name: 'Renamed Project', theme: 'dark' });
  const html = await page('/');
  assert.match(html, /Renamed Project/);
  assert.match(html, /data-theme="dark"/);
});

test('container alignment is configurable', async () => {
  await post('/config', { container_align: 'right' });
  assert.match(await page('/'), /class="container align-right"/);
  // invalid value ignored, falls back to a valid class
  await post('/config', { container_align: 'bogus' });
  assert.match(await page('/'), /class="container align-(left|center|right|fit)"/);
});

test('approve with a priority, change it, move it back to review', async () => {
  const id = await add('Approve me');
  assert.equal((await post(`/todos/${id}/approve`, { priority: 1 })).status, 200);
  const row = db.prepare('SELECT status, priority, approved_at FROM todos WHERE id = ?').get(id);
  assert.deepEqual([row.status, row.priority, Boolean(row.approved_at)], ['approved', 1, true]);
  assert.match(await page('/todos'), new RegExp(`Next round:</strong> the implementation agent starts with\\s+<a href="/todos/${id}">`));
  assert.equal((await post(`/todos/${id}/priority`, { priority: 3 })).status, 200);
  assert.equal((await post(`/todos/${id}/priority`, { priority: 9 })).status, 400);
  assert.equal((await post(`/todos/${id}/approve`, { priority: 2 })).status, 400); // already approved
  assert.equal((await post(`/todos/${id}/unapprove`, {})).status, 200);
  assert.equal(status(id), 'proposed');
  assert.match(await page(`/todos/${id}`), /Priority set to Low\.[\s\S]*Moved back to review\./);
});

test('reject archives with the reason; restore brings it back for review', async () => {
  const id = await add('Reject me');
  assert.equal((await post(`/todos/${id}/reject`, { reason: 'too big for one round' })).status, 200);
  assert.equal(status(id), 'archived');
  const list = await page('/todos');
  assert.match(list, /<details class="queue-section archived">[\s\S]*Reject me[\s\S]*too big for one round/);
  assert.equal((await post(`/todos/${id}/restore`, {})).status, 200);
  assert.equal(status(id), 'proposed');
});

test('only an archived todo that nothing needs can be deleted', async () => {
  const a = await add('Delete me');
  const b = await add('Needs the deleted one');
  assert.equal((await post(`/todos/${b}/deps`, { deps: String(a) })).status, 200);
  assert.equal((await post('/todos/delete', { ids: [a] })).status, 400);   // not archived
  await post(`/todos/${a}/reject`, { reason: '' });
  const refused = await post('/todos/delete', { ids: [a] });              // still needed by b
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, new RegExp(`needed by #${b}`));
  await post(`/todos/${b}/reject`, {});
  const del = await (await post('/todos/delete', { ids: [a] })).json();
  assert.equal(del.deleted, 1);
  assert.equal((await fetch(`${base}/todos/${a}`)).status, 404);
});

test('a todo waits for its prerequisites; "approve with" approves them too', async () => {
  const a = await add('Prereq A');
  const b = await add('Prereq B');
  const c = await add('Needs A and B');
  assert.equal((await post(`/todos/${c}/deps`, { deps: `${a}, #${b}` })).status, 200);
  const detail = await page(`/todos/${c}`);
  assert.match(detail, new RegExp(`Approve with #${a}, #${b}`));
  assert.equal((await post(`/todos/${c}/approve`, { priority: 1 })).status, 200);
  assert.match(await page('/todos'), /Waits for/);
  assert.equal(status(a), 'proposed');
  await post(`/todos/${c}/unapprove`, {});
  assert.equal((await post(`/todos/${c}/approve`, { priority: 1, with_prereqs: true })).status, 200);
  assert.deepEqual([status(a), status(b), status(c)], ['approved', 'approved', 'approved']);
});

test('prerequisite edits refuse loops and archived items', async () => {
  const a = await add('Loop A');
  const b = await add('Loop B');
  assert.equal((await post(`/todos/${b}/deps`, { deps: String(a) })).status, 200);
  const loop = await post(`/todos/${a}/deps`, { deps: String(b) });
  assert.equal(loop.status, 400);
  assert.match((await loop.json()).error, /loop/);
  assert.equal((await post(`/todos/${a}/deps`, { deps: String(a) })).status, 400);
  assert.equal((await post(`/todos/${a}/deps`, { deps: 'x' })).status, 400);
  const gone = await add('Archived prereq');
  await post(`/todos/${gone}/reject`, {});
  assert.equal((await post(`/todos/${a}/deps`, { deps: String(gone) })).status, 400);
});

test('graph view draws prerequisites as arrows between linked nodes', async () => {
  const a = await add('Graph base');
  const b = await add('Graph top');
  await post(`/todos/${b}/deps`, { deps: String(a) });
  await post('/config', { todo_view: 'graph' });
  const html = await page('/todos');
  assert.match(html, /<svg class="graph-svg"/);
  assert.match(html, new RegExp(`<a href="/todos/${a}" class="g-node st-proposed"`));
  assert.match(html, new RegExp(`<a href="/todos/${b}" class="g-node st-proposed"`));
  assert.match(html, /<path class="g-edge"/);
  assert.match(html, /class="graph-legend"/);
  assert.match(html, /Needs nothing and nothing needs it/);   // the earlier, unlinked todos
  assert.match(html, /class="seg-btn active"\s+data-view="graph"/);
  await post('/config', { todo_view: 'list' });
  assert.doesNotMatch(await page('/todos'), /<svg class="graph-svg"/);
});

test('titles are escaped in the list, the graph and the detail page', async () => {
  const id = await add('<img src=x onerror=alert(1)> & co');
  const other = await add('Needs the escaped one');
  await post(`/todos/${other}/deps`, { deps: String(id) });
  for (const view of ['list', 'graph']) {
    await post('/config', { todo_view: view });
    assert.doesNotMatch(await page('/todos'), /<img src=x/);
  }
  await post('/config', { todo_view: 'list' });
  assert.doesNotMatch(await page(`/todos/${id}`), /<img src=x/);
  assert.match(await page(`/todos/${id}`), /&lt;img src=x onerror=alert\(1\)&gt; &amp; co/);
});
