// Dashboard feature: the project overview / landing page at '/'.
// One column, read top to bottom: what happened lately, what needs you, what
// the agents do next, what shipped, and the log. Rows link into the Todos
// list and detail pages; decisions are made there.
import { esc, u, fmtTime } from '../core/layout.js';
import { standing, isYours } from '../core/seam.js';
import * as Q from '../queue.js';

const LIST_LIMIT = 5;
const FEED_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

const pr = (t) => (/^https?:\/\//i.test(String(t.pr_url || ''))
  ? ` <a class="pr" href="${esc(t.pr_url)}" target="_blank" rel="noopener">${esc(Q.prName(t.pr_url))}</a>` : '');

// SQLite's UTC 'YYYY-MM-DD HH:MM:SS' → true when it lies within the last day.
const lastDay = (s) => Boolean(s) && Date.now() - new Date(`${String(s).replace(' ', 'T')}Z`).getTime() < DAY_MS;

// The same first three columns as the Todos tables: number, status, title.
// A note (plain text) is the title's tooltip.
function row(t, nextId, note = '') {
  const status = t.status === 'shipped' ? `Shipped ${fmtTime(t.shipped_at).split(',')[0]}` : standing(t, nextId).word;
  return `<li class="item st-${t.status}">
    <span class="item-id"><span class="tag${isYours(t) ? ' yours' : ''}">#${t.id}</span></span>
    <span class="item-status">${esc(status)}</span>
    <div class="item-body"><a class="title" href="${u(`/todos/${t.id}`)}"${note ? ` title="${esc(note)}"` : ''}>${esc(t.title)}</a>${pr(t)}</div>
  </li>`;
}

function section(title, count, inner, { cls = '', more = '' } = {}) {
  return `
    <section class="queue-section${cls}">
      <h2>${title}${count == null ? '' : ` <span class="count">${count}</span>`}${more ? `<a class="more" href="${u('/todos')}">${more}</a>` : ''}</h2>
      ${inner}
    </section>`;
}

const COLS = '<li class="cols" aria-hidden="true"><span>#</span><span>Status</span><span>Item</span></li>';
const list = (items, render, empty) => `<ul class="item-list brief">${
  items.length ? COLS + items.slice(0, LIST_LIMIT).map(render).join('') : `<li class="muted empty">${empty}</li>`}</ul>`;

// ---------- Parts ----------
// The page's standing facts as one label/value table.
function overnight(state, next, mode) {
  const n = (f) => state.items.filter(f).length;
  const shipped = n((t) => t.status === 'shipped' && lastDay(t.shipped_at));
  const ideas = n((t) => t.source !== 'you' && lastDay(t.created_at));
  const approved = n((t) => lastDay(t.approved_at));
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const nextText = next.item
    ? `${next.resume ? 'continues' : 'starts'} <a href="${u(`/todos/${next.item.id}`)}">#${next.item.id} ${esc(next.item.title)}</a>`
    : `nothing to build; ${esc(next.why)}`;
  return `<dl class="facts overnight">
    <dt>Last 24 hours</dt><dd>${shipped} shipped · ${plural(ideas, 'new idea', 'new ideas')} · ${approved} approved</dd>
    <dt>Next round</dt><dd>${nextText}</dd>
    <dt>Approval</dt><dd>${mode}</dd></dl>`;
}

function yoursSection(state, nextId) {
  const order = { review: 0, failed: 1, proposed: 2 };
  const items = state.items.filter(isYours).sort((a, b) => order[a.status] - order[b.status] || a.id - b.id);
  const note = (t) => (t.status === 'failed' ? `Failed: ${t.status_note || 'no reason given'}`
    : t.status === 'review' ? 'A draft pull request waits for you to merge it.' : '');
  return section('Your turn', items.length,
    list(items, (t) => row(t, nextId, note(t)), 'Nothing needs you. The agents carry on.'),
    { more: items.length ? 'Open the queue →' : '' });
}

function agentsSection(state, nextId) {
  const items = [...state.items.filter((t) => t.status === 'in_progress'), ...Q.approvedInOrder(state)];
  const note = (t) => (t.status === 'in_progress' ? `Attempt ${t.attempts} of ${Q.MAX_ATTEMPTS}` : '');
  return section('Agents’ turn', items.length, list(items, (t) => row(t, nextId, note(t)), 'Nothing approved yet.'));
}

function shippedSection(state) {
  const shipped = state.items.filter((t) => t.status === 'shipped')
    .sort((a, b) => String(b.shipped_at || '').localeCompare(String(a.shipped_at || '')));
  return section('Recently shipped', null,
    list(shipped, (t) => row(t, null, `Shipped ${fmtTime(t.shipped_at)}`), 'Nothing shipped yet.'), { cls: ' done' });
}

function logSection(db) {
  const rows = db.prepare(`
    SELECT c.body, c.author, c.created_at, t.id FROM comments c
    JOIN todos t ON t.id = c.todo_id
    ORDER BY c.id DESC LIMIT ?`).all(FEED_LIMIT);
  const cut = (s) => (s.length > 140 ? `${s.slice(0, 139)}…` : s);
  const items = rows.length
    ? rows.map((r) => `<li><span class="log-meta">${esc(fmtTime(r.created_at))} · ${esc(r.author)}</span>
        <span><a href="${u(`/todos/${r.id}`)}">#${r.id}</a> ${esc(cut(r.body))}</span></li>`).join('')
    : '<li class="muted">No activity yet.</li>';
  return section('Log', null, `<ul class="log-list">${items}</ul>`);
}

function dashboardView(ctx) {
  const { db } = ctx;
  const settings = ctx.settings();
  const state = Q.loadState(db);
  const next = Q.nextItem(null, { state });
  const mode = settings.auto_approve ? 'automatic' : 'manual';
  return `
    <header class="dash-head">
      <input id="project-name" class="project-name" value="${esc(settings.project_name)}" aria-label="Project name">
    </header>
    ${overnight(state, next, mode)}
    ${yoursSection(state, next.item?.id)}
    ${agentsSection(state, next.item?.id)}
    ${shippedSection(state)}
    ${logSection(db)}
    ${ctx.runtime.target_dir ? `<p class="muted small">Target: <code>${esc(ctx.runtime.target_dir)}</code></p>` : ''}`;
}

export default {
  id: 'dashboard',
  order: 5,
  nav: { label: 'Dashboard', href: '/' },
  routes: [
    { method: 'GET', path: '/', handler: (ctx) => ctx.page({ title: 'Dashboard', body: dashboardView(ctx) }) },
  ],
};
