// Todos feature: the agent queue. The main page shows every item by where it
// stands (your turn, the agents' turn, shipped, archived), as a list or
// as a graph of prerequisites; the detail page holds an item's spec, its
// prerequisites, links and log. The queue rules live in src/queue.js.
//
// This is the reference example for how a feature is built: views are plain
// functions returning HTML strings; handlers read ctx and call ctx.page/ctx.json.
import { esc, u, fmtTime } from '../core/layout.js';
import { ICON } from '../core/icons.js';
import * as Q from '../queue.js';
import { renderGraph } from '../graph.js';
import { seam, standing, isYours } from '../core/seam.js';

// ---------- Small pieces ----------
const webUrl = (url) => /^https?:\/\//i.test(String(url || ''));

function prLink(t) {
  if (!webUrl(t.pr_url)) return '';
  return `<a class="pr" href="${esc(t.pr_url)}" target="_blank" rel="noopener">${esc(Q.prName(t.pr_url))}</a>`;
}

// What a prerequisite's status means for the item that needs it.
function needWords(d) {
  return d.status === 'proposed' ? 'not approved yet' : Q.STATUS_LABEL[d.status].toLowerCase();
}

function chip(state, id) {
  const d = state.byId.get(id);
  return `<a class="chip st-${d.status}" href="${u(`/todos/${id}`)}" title="${esc(`#${id} ${d.title} — ${Q.STATUS_LABEL[d.status]}`)}">#${id}${d.status === 'shipped' ? ' ✓' : ''}</a>`;
}

const sourceName = (t) => (t.source === 'you' ? 'you' : t.source);

// Auto shows what it resolves to: the suggestion agent's recommendation, else Normal.
function priorityOptions(t) {
  return Q.PRIORITIES.map((p) => `<option value="${p}"${p === (t?.priority ?? 0) ? ' selected' : ''}>${
    p === 0 && t ? esc(Q.priorityWords({ ...t, priority: 0 })) : Q.PRIORITY_LABEL[p]}</option>`).join('');
}

function prioritySelect(t, live) {
  return `<select class="js-priority"${live ? ' data-live="1"' : ''} aria-label="Priority"
    title="Priority. Auto uses the priority the suggestion agent recommended, or Normal.">${priorityOptions(t)}</select>`;
}

// The buttons an item offers in its current status. The list shows the ones
// for the next decision; the detail page shows them all.
function actions(state, t, { detail = false } = {}) {
  const btn = (action, label, extra = '') => `<button type="button" data-action="${action}"${extra}>${label}</button>`;
  const reject = (label = 'Reject') => btn('reject', label, ' class="danger"');
  const prio = (live) => (detail ? prioritySelect(t, live) : '');
  switch (t.status) {
    case 'proposed': {
      const pre = Q.unapprovedPrereqs(state, t.id);
      return prio(false) + btn('approve', 'Approve', ' class="primary"')
        + (pre.length ? btn('approve', `Approve with ${pre.map((d) => `#${d}`).join(', ')}`, ' data-with-prereqs="1"') : '')
        + reject();
    }
    case 'approved':
      return prio(true)
        + (detail ? btn('unapprove', 'Back to review') + btn('shipped', 'Mark shipped') + reject() : '');
    case 'failed':
      return btn('retry', 'Retry', ' class="primary"') + reject() + (detail ? btn('shipped', 'Mark shipped') : '');
    case 'in_progress':
    case 'review':
      return detail ? btn('shipped', 'Mark shipped') + reject('Archive') : '';
    case 'archived':
      return btn('restore', 'Restore') + (detail ? btn('delete', 'Delete', ' class="danger"') : '');
    default:
      return '';
  }
}

// One line on where the item stands, under its title.
function itemNote(state, t) {
  const p = (html) => `<p class="item-note">${html}</p>`;
  const waits = () => t.blockers.map((b) => `${chip(state, b)} <span class="muted">(${needWords(state.byId.get(b))})</span>`).join(', ');
  switch (t.status) {
    case 'proposed':
      return t.deps.length ? p(`Builds on ${t.deps.map((d) => chip(state, d)).join(' ')}`) : '';
    case 'approved':
      if (t.blockers.some((b) => state.byId.get(b).status === 'archived')) {
        return p(`Can never start: it needs ${waits()}. Change its prerequisites, or reject it.`);
      }
      return t.blockers.length ? p(`Waits for ${waits()}`) : '';
    case 'in_progress':
      return p(`Run ${esc(t.last_run || '?')}, attempt ${t.attempts} of ${Q.MAX_ATTEMPTS}${t.branch ? ` · <code>${esc(t.branch)}</code>` : ''}`);
    case 'review':
      return p('A draft pull request waits for you to merge it.');
    case 'failed':
      return p(`Failed: ${esc(t.status_note || 'no reason given')}`);
    case 'shipped':
      return p(`Shipped ${esc(fmtTime(t.shipped_at))}`);
    case 'archived':
      return p(`Archived ${esc(fmtTime(t.archived_at))}${t.status_note ? `: ${esc(t.status_note)}` : ''}`);
    default:
      return '';
  }
}

// The number tag. Yellow marks an item that waits for you, as nowhere else.
const tag = (t) => `<span class="tag${isYours(t) ? ' yours' : ''}">#${t.id}</span>`;

// A queue row is one line, one value per cell: number, status, title,
// priority, decision. The longer note (the spec's Change line, why it failed,
// what it waits for) is the title's tooltip and sits in full on the item's page.
function noteText(t) {
  switch (t.status) {
    case 'proposed': return (/\*\*Change:\*\*\s*(.+)/.exec(t.explanation || '') || [])[1] || '';
    case 'failed': return `Failed: ${t.status_note || 'no reason given'}`;
    case 'approved': return t.blockers.length ? `Waits for ${t.blockers.map((b) => `#${b}`).join(', ')}` : '';
    case 'archived': return t.status_note || '';
    default: return '';
  }
}

function statusWord(t, nextId) {
  if (t.status === 'in_progress') return `Building ${t.attempts}/${Q.MAX_ATTEMPTS}`;
  if (t.status === 'approved' && t.blockers.length && t.id !== nextId) return `Waits #${t.blockers[0]}`;
  return standing(t, nextId).word;
}

function itemRow(state, t, nextId) {
  const note = noteText(t);
  const prio = ['proposed', 'approved'].includes(t.status)
    ? prioritySelect(t, t.status === 'approved') : esc(Q.priorityWords(t));
  const act = t.status === 'review' && webUrl(t.pr_url)
    ? `<a class="btn" href="${esc(t.pr_url)}" target="_blank" rel="noopener">Open ${esc(Q.prName(t.pr_url))}</a>`
    : actions(state, t) || prLink(t);
  return `
  <li class="item st-${t.status}" data-id="${t.id}" data-title="${esc(t.title)}" data-status="${t.status}">
    <span class="item-id">${tag(t)}</span>
    <span class="item-status">${statusWord(t, nextId)}</span>
    <div class="item-body"><a class="title" href="${u(`/todos/${t.id}`)}"${note ? ` title="${esc(note)}"` : ''}>${esc(t.title)}</a></div>
    <div class="item-prio">${prio}</div>
    <div class="item-actions">${act}</div>
  </li>`;
}

// ---------- Views ----------
function nextLine(next) {
  if (next.item) {
    const verb = next.resume ? 'continues with' : 'starts with';
    return `<p class="next-line"><strong>Next round:</strong> the implementation agent ${verb}
      <a href="${u(`/todos/${next.item.id}`)}">#${next.item.id} ${esc(next.item.title)}</a>.</p>`;
  }
  return `<p class="next-line"><strong>Next round:</strong> nothing to build; ${esc(next.why)}.</p>`;
}

function listView(settings, state, nextId) {
  const of = (s) => state.items.filter((t) => t.status === s);
  const latest = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || '')) || b.id - a.id;
  // Each section is one table: a column header row, then one row per item.
  const cols = (list) => (list.length
    ? '<li class="cols" aria-hidden="true"><span>#</span><span>Status</span><span>Item</span><span>Priority</span><span>Action</span></li>' : '');
  const rows = (list) => cols(list) + list.map((t) => itemRow(state, t, nextId)).join('');
  const section = (title, list, hint, empty, cls = '') => `
    <section class="queue-section${cls}">
      <h2>${title} <span class="count">${list.length}</span></h2>
      ${hint ? `<p class="muted small hint">${hint}</p>` : ''}
      <ul class="item-list">${rows(list) || `<li class="muted empty">${empty}</li>`}</ul>
    </section>`;
  const archived = of('archived').sort(latest('archived_at'));
  return section('Your turn', [...of('review'), ...of('failed'), ...of('proposed')],
    'Merge finished work, retry what failed, and approve or reject new ideas. Rejected ideas move to Archived.', 'Nothing needs you.')
    + section('Agents’ turn', [...of('in_progress'), ...Q.approvedInOrder(state)],
      'Built in this order, several side by side when their specs name different files. An item starts once everything it needs has shipped.', 'Nothing approved yet.')
    + (settings.show_completed ? section('Shipped', of('shipped').sort(latest('shipped_at')), '', 'Nothing shipped yet.', ' done') : '')
    + (archived.length ? `
    <details class="queue-section archived">
      <summary><h2>Archived <span class="count">${archived.length}</span></h2></summary>
      <ul class="item-list">${rows(archived)}</ul>
    </details>` : '');
}

function graphMeta(t, nextId) {
  const p = Q.priorityWords(t);
  const words = {
    proposed: 'needs your review',
    approved: t.id === nextId ? `${p} · next up` : t.ready ? `${p} · ready` : `${p} · waiting`,
    in_progress: 'in progress',
    review: 'waiting for your merge',
    shipped: 'shipped',
    failed: 'failed',
    archived: 'archived',
  };
  return `#${t.id} · ${words[t.status]}`;
}

const LEGEND = `
  <ul class="graph-legend" aria-label="Legend">
    <li><span class="key st-proposed"></span>Your turn: review, merge or retry</li>
    <li><span class="key st-approved"></span>Approved</li>
    <li><span class="key st-in_progress"></span>Building</li>
    <li><span class="key st-shipped"></span>Shipped</li>
    <li><span class="key st-archived"></span>Archived</li>
    <li><span class="key-arrow">→</span>points from a prerequisite to what needs it</li>
  </ul>`;

function graphView(settings, state, nextId) {
  const open = (t) => !['shipped', 'archived'].includes(t.status);
  const keep = new Set(state.items.filter((t) => open(t) || (settings.show_completed && t.status === 'shipped')).map((t) => t.id));
  // An open item's shipped or archived prerequisites stay in the picture: they say why it can or cannot start.
  for (const t of state.items) if (open(t)) t.deps.forEach((d) => keep.add(d));
  const shown = state.items.filter((t) => keep.has(t.id));
  const edges = [];
  const linked = new Set();
  for (const t of shown) {
    for (const d of t.deps) {
      if (!keep.has(d)) continue;
      edges.push([d, t.id, state.byId.get(d).status === 'shipped']);
      linked.add(d).add(t.id);
    }
  }
  const order = (a, b) => a.effective_priority - b.effective_priority || a.id - b.id;
  const nodes = shown.filter((t) => linked.has(t.id)).sort(order).map((t) => ({
    id: t.id,
    title: t.title,
    meta: graphMeta(t, nextId),
    cls: `st-${t.status}${t.ready ? ' ready' : ''}${t.id === nextId ? ' next' : ''}`,
    label: `#${t.id} ${t.title} — ${Q.STATUS_LABEL[t.status]}`,
  }));
  const loose = shown.filter((t) => !linked.has(t.id)).sort(order);
  const looseList = loose.length ? `
    <h3 class="loose-title">Needs nothing and nothing needs it <span class="count">${loose.length}</span></h3>
    <ul class="loose-list">${loose.map((t) => `<li>${chip(state, t.id)} <a href="${u(`/todos/${t.id}`)}">${esc(t.title)}</a>
      <span class="muted small">${esc(graphMeta(t, nextId).replace(/^#\d+ · /, ''))}</span></li>`).join('')}</ul>` : '';
  if (!shown.length) return '<p class="muted empty">No todos. Add one above.</p>';
  return `${LEGEND}
    <div class="graph-wrap">${nodes.length ? renderGraph(nodes, edges) : '<p class="muted">No item needs another yet.</p>'}</div>
    ${looseList}`;
}

function mainView(settings, state) {
  const next = Q.nextItem(null, { state });
  const nextId = next.item?.id;
  const graph = settings.todo_view === 'graph';
  const seg = (view, icon, label) => `<button type="button" class="seg-btn${settings.todo_view === view ? ' active' : ''}"
      data-view="${view}" aria-pressed="${settings.todo_view === view}">${icon}<span>${label}</span></button>`;
  return `
    <header class="topbar">
      <input id="project-name" class="project-name" value="${esc(settings.project_name)}" aria-label="Project name">
      <div class="settings">
        <div class="seg" role="group" aria-label="View">${seg('list', ICON.list, 'List')}${seg('graph', ICON.graph, 'Graph')}</div>
        <button id="toggle-completed" class="icon-toggle ${settings.show_completed ? 'active' : ''}"
                aria-pressed="${settings.show_completed ? 'true' : 'false'}"
                title="show or hide shipped items">${settings.show_completed ? ICON.eye : ICON.eyeOff}</button>
        <button id="toggle-auto-approve" class="approval-switch" type="button" role="switch"
                aria-checked="${settings.auto_approve ? 'true' : 'false'}" aria-label="Auto approval"
                title="Approve suitable waiting ideas automatically from the next round"><span class="switch-track" aria-hidden="true"></span>Auto approval</button>
      </div>
    </header>
    ${nextLine(next)}
    <div class="toolbar">
      <form id="add-form" class="add-form">
        <input type="text" id="add-title" placeholder="Your own idea for a feature…" maxlength="200" required>
        <select id="add-priority" aria-label="Priority" title="Priority if you approve it now. Auto = Normal for your own ideas.">${priorityOptions(null)}</select>
        <button type="submit" data-approve="0" title="Adds it and opens it, so you can write the spec, then approve it">+ Add</button>
        <button type="submit" data-approve="1" title="The implementation agent may build it from the next round">Add &amp; approve</button>
      </form>
    </div>
    ${graph ? graphView(settings, state, nextId) : listView(settings, state, nextId)}`;
}

function commentItem(c) {
  return `<li class="comment" data-id="${c.id}">
    <div class="comment-meta"><span class="muted small">${esc(fmtTime(c.created_at))} · ${esc(c.author)}</span>
      <button type="button" class="comment-delete danger" aria-label="Delete comment">✕</button></div>
    <textarea class="comment-edit" rows="2" aria-label="Edit comment">${esc(c.body)}</textarea>
  </li>`;
}

function detailView(state, t, comments) {
  const next = Q.nextItem(null, { state });
  const log = comments.length ? comments.map(commentItem).join('') : '<li class="muted">No comments yet.</li>';
  const editableDeps = !['shipped', 'archived'].includes(t.status);
  const chips = (list) => list.map((d) => `${chip(state, d)} <span class="muted small">${esc(state.byId.get(d).title)} (${needWords(state.byId.get(d))})</span>`).join('<br>');
  const raised = t.effective_priority < t.base_priority ? `, treated as ${Q.PRIORITY_LABEL[t.effective_priority]} because approved work needs it` : '';
  const prio = t.status === 'proposed' ? '' : ` · ${esc(Q.priorityWords(t))} priority${raised}`;
  // An approved item's status word already says next up, ready or waiting.
  const where = t.id === next.item?.id && t.status !== 'approved' ? ' · next up' : '';
  const hasSpec = t.explanation.trim() !== '';
  return `
    <p><a href="${u('/todos')}" class="back">← Back</a></p>
    <textarea id="todo-title" class="detail-title" rows="1" aria-label="Todo title">${esc(t.title)}</textarea>

    <section class="card item-card st-${t.status}" data-id="${t.id}" data-title="${esc(t.title)}" data-status="${t.status}">
      <p class="status-line">${tag(t)} <span class="item-state">${seam(t, next.item?.id)}</span><span>${(prio + where).replace(/^ · /, '')}</span></p>
      ${itemNote(state, t)}
      <div class="item-actions">${actions(state, t, { detail: true })}</div>
      <dl class="facts">
        <dt>Needs</dt>
        <dd>${t.deps.length ? chips(t.deps) : '<span class="muted">Nothing</span>'}
          ${editableDeps ? `<form id="deps-form" class="deps-form">
            <label class="muted" for="deps-input">Change:</label>
            <input id="deps-input" name="deps" value="${esc(t.deps.join(', '))}" placeholder="item numbers, e.g. 3, 5">
            <button type="submit">Save</button></form>` : ''}</dd>
        <dt>Needed by</dt>
        <dd>${t.dependents.length ? chips(t.dependents) : '<span class="muted">Nothing</span>'}</dd>
        <dt>From</dt>
        <dd>${esc(sourceName(t))}${t.run_id ? `, run ${esc(t.run_id)}` : ''} · ${esc(fmtTime(t.created_at))}</dd>
        ${t.suggested_priority ? `<dt>Suggested priority</dt><dd>${Q.PRIORITY_LABEL[t.suggested_priority]} <span class="muted small">(used while the priority is Auto)</span></dd>` : ''}
        ${t.branch ? `<dt>Branch</dt><dd><code>${esc(t.branch)}</code></dd>` : ''}
        ${webUrl(t.pr_url) ? `<dt>Pull request</dt><dd><a href="${esc(t.pr_url)}" target="_blank" rel="noopener">${esc(t.pr_url)}</a></dd>` : ''}
        ${t.attempts ? `<dt>Attempts</dt><dd>${t.attempts} of ${Q.MAX_ATTEMPTS}${t.last_run ? `, last in run ${esc(t.last_run)}` : ''}</dd>` : ''}
      </dl>
    </section>

    <section class="card">
      <h2>Spec</h2>
      <div class="md-tabs">
        <button type="button" class="tab${hasSpec ? '' : ' active'}" data-tab="write">Write</button>
        <button type="button" class="tab${hasSpec ? ' active' : ''}" data-tab="preview">Preview</button>
      </div>
      <textarea id="explanation" class="explanation" rows="12"${hasSpec ? ' hidden' : ''}
        placeholder="What to build and why (markdown). The implementation agent works from this.">${esc(t.explanation)}</textarea>
      <div id="preview" class="preview md-body"${hasSpec ? ' data-initial="1"' : ' hidden'}></div>
      <div class="row">
        <button id="save-explanation">Save</button>
      </div>
    </section>
    <section class="card">
      <h2>Log</h2>
      <ul class="comment-list">${log}</ul>
      <form id="add-comment" class="add-comment">
        <textarea name="body" rows="3" placeholder="Add a note…" required></textarea>
        <button type="submit">Comment</button>
      </form>
    </section>`;
}

// ---------- Handlers ----------
function home(ctx) {
  const settings = ctx.settings();
  ctx.page({ title: `${settings.project_name} — Todos`, body: mainView(settings, Q.loadState(ctx.db)) });
}

function detail(ctx) {
  const state = Q.loadState(ctx.db);
  const t = state.byId.get(Number(ctx.params.id));
  if (!t) return ctx.notFound('Todo not found');
  ctx.page({ title: `${t.title} — Todos`, body: detailView(state, t, Q.itemLog(ctx.db, t.id)) });
}

// A queue change from the page: QueueError messages go back to the person as 400s.
const change = (fn) => async (ctx) => {
  try {
    const out = await fn(ctx, await ctx.body(), Number(ctx.params.id));
    ctx.json(200, { ok: true, ...out });
  } catch (e) {
    if (e instanceof Q.QueueError) return ctx.json(400, { error: e.message });
    throw e;
  }
};

// Your own idea: it waits for your review like any other, unless you add and approve it at once.
function addYours(db, b) {
  return db.transaction(() => {
    const id = Q.addItem(db, { title: b.title, body: typeof b.body === 'string' ? b.body : '' });
    if (b.approve) Q.approve(db, id, b.priority ?? 0);
    return id;
  })();
}

async function updateConfig(ctx) {
  const b = await ctx.body();
  if (b.auto_approve !== undefined && typeof b.auto_approve !== 'boolean')
    return ctx.json(400, { error: 'auto_approve must be true or false' });
  if (typeof b.project_name === 'string' && b.project_name.trim())
    ctx.db.prepare('UPDATE config SET project_name = ? WHERE id = 1').run(b.project_name.trim());
  if (b.show_completed !== undefined)
    ctx.db.prepare('UPDATE config SET show_completed = ? WHERE id = 1').run(b.show_completed ? 1 : 0);
  if (b.theme === 'light' || b.theme === 'dark')
    ctx.db.prepare('UPDATE config SET theme = ? WHERE id = 1').run(b.theme);
  if (['left', 'center', 'right', 'fit'].includes(b.container_align))
    ctx.db.prepare('UPDATE config SET container_align = ? WHERE id = 1').run(b.container_align);
  if (b.todo_view === 'list' || b.todo_view === 'graph')
    ctx.db.prepare('UPDATE config SET todo_view = ? WHERE id = 1').run(b.todo_view);
  if (b.auto_approve !== undefined)
    ctx.db.prepare('UPDATE config SET auto_approve = ? WHERE id = 1').run(b.auto_approve ? 1 : 0);
  ctx.json(200, { ok: true });
}

// Only archived items can be deleted, and only once nothing still needs them:
// a deleted prerequisite would silently free the items that wait on it.
async function deleteTodos(ctx) {
  const b = await ctx.body();
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  const state = Q.loadState(ctx.db);
  const refused = [];
  let deleted = 0;
  for (const id of ids) {
    const t = state.byId.get(id);
    if (!t) continue;
    const needers = t.dependents.filter((d) => state.byId.get(d).status !== 'archived');
    if (t.status !== 'archived') refused.push(`#${id} is not archived`);
    else if (needers.length) refused.push(`#${id} is still needed by ${needers.map((d) => `#${d}`).join(', ')}`);
    else { ctx.db.prepare('DELETE FROM todos WHERE id = ?').run(id); deleted++; }
  }
  if (refused.length && !deleted) return ctx.json(400, { error: `Not deleted: ${refused.join('; ')}.` });
  ctx.json(200, { ok: true, deleted, refused });
}

async function saveTitle(ctx) {
  const b = await ctx.body();
  const title = String(b.title || '').replace(/\s+/g, ' ').trim();
  const id = Number(ctx.params.id);
  if (!title) return ctx.json(400, { error: 'title required' });
  if (title.length > 200) return ctx.json(400, { error: 'title is longer than 200 characters; put the detail in the spec' });
  const same = ctx.db.prepare('SELECT id FROM todos WHERE lower(title) = lower(?) AND id <> ?').get(title, id);
  if (same) return ctx.json(400, { error: `#${same.id} already has this title` });
  ctx.db.prepare('UPDATE todos SET title = ? WHERE id = ?').run(title, id);
  ctx.json(200, { ok: true });
}

async function saveExplanation(ctx) {
  const b = await ctx.body();
  ctx.db.prepare('UPDATE todos SET explanation = ? WHERE id = ?').run(b.explanation || '', Number(ctx.params.id));
  ctx.json(200, { ok: true });
}

async function addComment(ctx) {
  const b = await ctx.body();
  const body = (b.body || '').trim();
  if (!body) return ctx.json(400, { error: 'comment body required' });
  const info = ctx.db.prepare('INSERT INTO comments (todo_id, body) VALUES (?, ?)')
    .run(Number(ctx.params.id), body);
  ctx.json(200, { ok: true, id: info.lastInsertRowid });
}

async function updateComment(ctx) {
  const b = await ctx.body();
  const body = (b.body || '').trim();
  if (!body) return ctx.json(400, { error: 'comment body required' });
  ctx.db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(body, Number(ctx.params.id));
  ctx.json(200, { ok: true });
}

function deleteComment(ctx) {
  ctx.db.prepare('DELETE FROM comments WHERE id = ?').run(Number(ctx.params.id));
  ctx.json(200, { ok: true });
}

export default {
  id: 'todos',
  order: 10,
  nav: { label: 'Todos', href: '/todos' },
  routes: [
    { method: 'GET', path: '/todos', handler: home },
    { method: 'GET', path: '/todos/:id', handler: detail },
    { method: 'POST', path: '/config', handler: updateConfig },
    { method: 'POST', path: '/todos', handler: change((ctx, b) => ({ id: addYours(ctx.db, b) })) },
    { method: 'POST', path: '/todos/delete', handler: deleteTodos },
    { method: 'POST', path: '/todos/:id/approve', handler: change((ctx, b, id) => Q.approve(ctx.db, id, b.priority ?? 0, { withPrereqs: Boolean(b.with_prereqs) })) },
    { method: 'POST', path: '/todos/:id/unapprove', handler: change((ctx, b, id) => Q.unapprove(ctx.db, id)) },
    { method: 'POST', path: '/todos/:id/priority', handler: change((ctx, b, id) => Q.setPriority(ctx.db, id, b.priority)) },
    { method: 'POST', path: '/todos/:id/reject', handler: change((ctx, b, id) => Q.archive(ctx.db, id, b.reason)) },
    { method: 'POST', path: '/todos/:id/restore', handler: change((ctx, b, id) => Q.restore(ctx.db, id)) },
    { method: 'POST', path: '/todos/:id/retry', handler: change((ctx, b, id) => Q.retry(ctx.db, id)) },
    { method: 'POST', path: '/todos/:id/shipped', handler: change((ctx, b, id) => Q.markShipped(ctx.db, id)) },
    { method: 'POST', path: '/todos/:id/deps', handler: change((ctx, b, id) => Q.setDeps(ctx.db, id, b.deps ?? '')) },
    { method: 'POST', path: '/todos/:id/title', handler: saveTitle },
    { method: 'POST', path: '/todos/:id/explanation', handler: saveExplanation },
    { method: 'POST', path: '/todos/:id/comments', handler: addComment },
    { method: 'POST', path: '/comments/:id', handler: updateComment },
    { method: 'POST', path: '/comments/:id/delete', handler: deleteComment },
  ],
};
