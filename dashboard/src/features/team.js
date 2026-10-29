// The team page: the form adds a role; the team itself is where you edit or
// remove one. Changes wait for the next round, which reads the descriptions,
// writes each role's instructions and switches the team. Edited and removed
// roles are marked on their rows, old value → new; added roles wait in a list
// of their own under the team.
import { esc, fmtTime, u } from '../core/layout.js';
import { inherited } from '../default-team.js';
import { EFFORTS } from '../team-config.js';
import { getTeamService } from '../team.js';

const MARK = { edit: 'Edited · from the next round', remove: 'Removed · leaves at the next round' };
const VERB = { edit: 'edited', add: 'added', remove: 'removed' };
const PROTOCOL = { suggest: 'SUGGEST.md', implement: 'IMPLEMENT.md' };
const MODELS = ['opus', 'sonnet', 'fable', 'haiku'];
const at = (iso) => fmtTime(String(iso || '').slice(0, 19).replace('T', ' '));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const COLS = '<li class="cols" aria-hidden="true"><span>Role</span><span>Agents</span><span>Does</span><span>Authority</span><span>Model / effort</span><span>Action</span></li>';

// What a row runs with: its own model and effort, or what it inherits.
function runsWith(row, settings) {
  const base = inherited(row, settings);
  const unset = [!row.model && 'model', !row.effort && 'effort'].filter(Boolean);
  return { model: row.model || base.model || 'default', effort: row.effort || base.effort || 'default',
    note: unset.length === 2 ? 'default' : unset.length ? `default ${unset[0]}` : '' };
}

function choice(name, label, values, current, fallback, off) {
  const list = current && !values.includes(current) ? [...values, current] : values;
  return `<select name="${name}" aria-label="${label}"${off}>
      <option value="">Default${fallback ? ` (${esc(fallback)})` : ''}</option>
      ${list.map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('')}
    </select>`;
}
const modelChoice = (row, settings, off) => choice('model', 'Model', MODELS, row.model, inherited(row, settings).model, off);
const effortChoice = (row, settings, off) => choice('effort', 'Effort', EFFORTS, row.effort, inherited(row, settings).effort, off);
const rowsFor = (text) => Math.min(12, Math.max(2, Math.ceil(String(text || '').length / 42)));

function addCard(snapshot, off) {
  const s = snapshot.settings;
  return `<section class="card">
    <h2>Add a role</h2>
    <p>Describe the work in your own words. At the next round an agent turns it into the role's instructions.</p>
    <form id="team-add-form" class="role-form" action="${u('/team/roles')}" method="POST">
      <div class="role-fields">
        <label>Role name <input name="name" maxlength="100" required${off}></label>
        <label>Agents <input name="count" type="number" min="1" step="1" value="1" required${off}></label>
        <label>Model ${modelChoice({}, s, off)}</label>
        <label>Effort ${effortChoice({}, s, off)}</label>
        <label class="wide">Description <textarea name="description" rows="3" maxlength="8000" required${off}></textarea></label>
      </div>
      <div class="row"><button type="submit" class="primary"${off}>Add role</button>
        <span class="muted">It joins the team from the next round. At most ${snapshot.maxAgents} agents per round.</span></div>
    </form>
  </section>`;
}

// What the role's agent is told. Built-in roles keep their protocol file.
function instructions({ row, role }, isDefault) {
  const file = row.builtin ? `Built in: <code>${PROTOCOL[row.builtin]}</code>, as today` : '';
  if (row.builtin && isDefault) return `${file}.`;
  if (!role) return '';
  return `${file ? `${file}, with this focus from your description:` : ''}<span class="instr-text">${esc(role.instructions)}</span>`;
}

// Word by word, what an edit takes out and puts in. Only words and marks
// are compared; each keeps the spacing before it. Very long texts are shown
// whole, old then new, instead.
function words(was, now) {
  const tokens = (text) => [...text.matchAll(/(\s*)([\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-])/gu)].map(([, space, word]) => ({ space, word }));
  const a = tokens(was), b = tokens(now);
  if (a.length * b.length > 250000) return `<del>${esc(was)}</del> <ins>${esc(now)}</ins>`;
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i].word === b[j].word ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const parts = [];
  const push = (kind, { space, word }) => {
    const last = parts.at(-1);
    if (last && last.kind === kind) last.text += space + word; else parts.push({ kind, space, text: word });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].word === b[j].word) { push('same', b[j]); i++; j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) push('del', a[i++]);
    else push('ins', b[j++]);
  }
  // A replacement reads old, then new, with a space between them.
  const gap = (space, kind, k) => (!space && kind === 'ins' && parts[k - 1]?.kind === 'del' ? ' ' : esc(space));
  return parts.map(({ kind, space, text }, k) => gap(space, kind, k) + (kind === 'same' ? esc(text) : `<${kind}>${esc(text)}</${kind}>`)).join('');
}

// One field of an edited role: old → new, or word by word for a description.
function changed(was, now, { long = false } = {}) {
  if (was === now) return esc(now);
  return long ? words(was, now) : `<s>${esc(was)}</s> → <ins>${esc(now)}</ins>`;
}

function modelCell(row, settings, was) {
  const now = runsWith(row, settings);
  const before = was ? runsWith(was, settings) : now;
  const note = now.note ? `<span class="dflt">${now.note}</span>` : '';
  return `${changed(before.model, now.model)} / ${changed(before.effort, now.effort)}${note}`;
}

// The edit row keeps the table's columns: each value becomes its field in place.
function editRow(item, snapshot, off) {
  const { row, role, change } = item;
  const s = snapshot.settings;
  const fixed = row.builtin === 'suggest' ? ' readonly title="The Suggestion role runs one agent."' : '';
  const authority = change === 'add' || !role ? 'set at the next round' : esc(role.capabilities.includes('build') ? 'builds' : role.authority);
  return `<li class="item editing" data-team-form="${esc(row.id)}" hidden>
    <form class="role-edit">
      <span class="role-name"><span class="cell-label">Role</span><input name="name" value="${esc(row.name)}" maxlength="100" required aria-label="Role name"${off}></span>
      <span class="role-count"><span class="cell-label">Agents</span><input name="count" type="number" min="1" step="1" value="${row.count}" required aria-label="Agents"${fixed}${off}></span>
      <span class="role-does"><span class="cell-label">Does</span><textarea name="description" rows="${rowsFor(row.description)}" maxlength="8000" required aria-label="Description"${off}>${esc(row.description)}</textarea>
        <span class="edit-note">Saved changes take effect from the next round.</span></span>
      <span class="role-authority"><span class="cell-label">Authority</span><span class="muted">${authority}</span><span class="edit-note">follows the description</span></span>
      <span class="role-model"><span class="cell-label">Model / effort</span>${modelChoice(row, s, off)}${effortChoice(row, s, off)}</span>
      <span class="item-actions"><button type="submit" class="primary"${off}>Save</button><button type="button" data-team-cancel>Cancel</button></span>
    </form>
  </li>`;
}

function roleRow(item, snapshot, off) {
  const { row, was, role, change } = item;
  const id = esc(row.id);
  const authority = role ? esc(role.capabilities.includes('build') ? 'builds' : role.authority) : '—';
  const told = change ? '' : instructions(item, snapshot.isDefault);
  const stage = role?.stage && snapshot.team?.stages.length > 1 ? `<span class="role-stage muted">${esc(role.stage)}</span>` : '';
  const undo = `<button type="button" data-team-undo="${id}"${off}>Undo</button>`;
  const actions = change === 'remove' ? undo
    : `<button type="button" data-team-edit="${id}"${off}>Edit</button>${change ? undo : `<button type="button" class="danger" data-team-remove="${id}"${off}>Remove</button>`}`;
  const tag = change ? `<span class="tag">${MARK[change]}</span>` : '';
  const instr = told ? `<details class="instr"><summary>Instructions</summary><div class="instr-body">${told}</div></details>` : '';
  const edit = change === 'edit';
  const name = edit ? changed(was.name, row.name) : esc(row.name);
  const count = edit ? changed(String(was.count), String(row.count)) : row.count;
  const desc = edit ? changed(was.description, row.description, { long: true }) : esc(row.description);
  const display = `<li class="item${change ? ` ch-${change}` : ''}" data-team-row="${id}">
    <span class="role-name"><strong>${name}</strong>${stage}</span>
    <span class="role-count">${count}</span>
    <span class="role-does">${tag}<span class="desc">${desc}</span>${instr}</span>
    <span class="role-authority">${authority}</span>
    <span class="role-model">${modelCell(row, snapshot.settings, edit ? was : null)}</span>
    <span class="item-actions">${actions}</span>
  </li>`;
  return change === 'remove' ? display : display + editRow(item, snapshot, off);
}

// Roles you added wait in their own list until the next round takes them in.
function addedRow(item, snapshot, off) {
  const { row } = item;
  const id = esc(row.id);
  return `<li class="item ch-add" data-team-row="${id}">
    <span class="role-name"><strong>${esc(row.name)}</strong></span>
    <span class="role-count">${row.count}</span>
    <span class="role-does"><span class="desc">${esc(row.description)}</span></span>
    <span class="role-authority muted">set at the next round</span>
    <span class="role-model">${modelCell(row, snapshot.settings, null)}</span>
    <span class="item-actions"><button type="button" data-team-edit="${id}"${off}>Edit</button><button type="button" data-team-undo="${id}"${off}>Undo</button></span>
  </li>${editRow(item, snapshot, off)}`;
}

function lead(snapshot) {
  const last = snapshot.lastApply;
  const builds = snapshot.view.find((v) => v.row.builtin === 'implement' && !v.change)?.row.count ?? snapshot.settings.maxBuilds;
  const base = snapshot.isDefault
    ? `This is the default team: every round, one agent suggests ideas and ${builds === 1 ? 'one builds' : `${builds} build`} what you approved, side by side.`
    : 'Every round runs this team.';
  if (snapshot.applying) return `${base} <strong>The round is applying your changes now.</strong>`;
  if (last?.status !== 'applied' || snapshot.changes) return base;
  const what = last.changes.map((c) => `${c.name} ${VERB[c.change]}`).join(', ');
  return last.default
    ? `${base} The ${esc(at(last.finishedAt))} round returned to it (${esc(what)}).`
    : `${base} The ${esc(at(last.finishedAt))} round applied your changes (${esc(what)}). Open <b>Instructions</b> on a role to see how its agent reads your description.`;
}

const KEY = '<span class="change-key"><s>runs now</s> → <ins>from the next round</ins></span>';

export function teamPage(snapshot, { autoApprove = false } = {}) {
  const off = !snapshot.available || snapshot.applying ? ' disabled' : '';
  const last = snapshot.lastApply;
  const failed = last?.status === 'failed' && snapshot.changes && !snapshot.applying;
  const team = snapshot.view.filter((item) => item.change !== 'add');
  const added = snapshot.view.filter((item) => item.change === 'add');
  const edits = team.some((item) => item.change === 'edit');
  return `<div id="team-page" data-applying="${snapshot.applying ? '1' : '0'}">
    <h1>Team</h1>
    <p class="lead">Every round runs your team. Add a role with the form, or edit and remove roles in the team below. Changes wait for the next round: it reads your descriptions, writes each role's instructions, then runs with the new team.</p>
    ${!snapshot.available ? '<p class="error">Set SHOEMAKER_STATE to configure this project’s team.</p>' : ''}
    ${addCard(snapshot, off)}
    <section class="card" aria-live="polite">
      <h2>Active team${snapshot.isDefault ? ': default' : ''}</h2>
      <p>${lead(snapshot)}</p>
      ${snapshot.activeError ? `<p class="error">The saved team is not valid, so rounds stop before any agent starts: ${esc(snapshot.activeError)}. Edit or remove roles below to fix it.</p>` : ''}
      ${failed ? `<p class="error">The ${esc(at(last.finishedAt))} round could not apply your changes (${esc(String(last.error).replace(/\.$/, ''))}). They still wait for the next round; edit them or press Undo.${last.logs ? ` Logs: <code>${esc(last.logs)}</code>` : ''}</p>` : ''}
      ${snapshot.changes ? `<div class="row waiting"><span><strong>${plural(snapshot.changes, 'change')}</strong> take${snapshot.changes === 1 ? 's' : ''} effect when the next round starts.${edits ? ` ${KEY}` : ''}</span>
        <button type="button" class="danger" data-team-undo-all${off}>Undo all</button></div>` : ''}
      <section class="queue-section team-ledger">
        <ul class="item-list">${COLS}${team.map((item) => roleRow(item, snapshot, off)).join('')}</ul>
      </section>
      ${added.length ? `<section class="queue-section team-ledger joining">
        <h2>Joining at the next round <span class="count">${added.length}</span></h2>
        <ul class="item-list">${COLS}${added.map((item) => addedRow(item, snapshot, off)).join('')}</ul>
      </section>` : ''}
      <p class="error" id="team-error" role="alert" hidden></p>
      ${snapshot.available ? `<p class="muted">Auto approval is ${autoApprove ? 'on: an auto-approval agent also runs each round' : 'off'}. Switch it on the Todos page.</p>` : ''}
    </section>
  </div><script src="${u('/static/team.js')}" defer></script>`;
}

function mutation(handler) {
  return async (ctx) => {
    try { await handler(ctx, getTeamService()); ctx.json(200, { ok: true }); }
    catch (error) { ctx.json(error.status || 400, { error: error.message }); }
  };
}

export default {
  id: 'team',
  order: 15,
  nav: { label: 'Team', href: '/team' },
  routes: [
    { method: 'GET', path: '/team', handler: (ctx) => ctx.page({ title: 'Team',
      body: teamPage(getTeamService().status(), { autoApprove: Boolean(ctx.settings().auto_approve) }) }) },
    { method: 'GET', path: '/team/status', handler: (ctx) => ctx.json(200, getTeamService().status()) },
    { method: 'POST', path: '/team/roles', handler: mutation(async (ctx, service) => service.add(await ctx.body())) },
    { method: 'POST', path: '/team/roles/:id', handler: mutation(async (ctx, service) => service.edit(ctx.params.id, await ctx.body())) },
    { method: 'POST', path: '/team/roles/:id/remove', handler: mutation(async (ctx, service) => service.remove(ctx.params.id)) },
    { method: 'POST', path: '/team/roles/:id/undo', handler: mutation(async (ctx, service) => service.undo(ctx.params.id)) },
    { method: 'POST', path: '/team/undo', handler: mutation(async (ctx, service) => service.undoAll()) },
  ],
};
