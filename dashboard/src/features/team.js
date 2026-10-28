// The team page: the form adds a role; the team itself is where you edit or
// remove one. Changes wait, marked on their rows, until the next round reads
// the descriptions, writes each role's instructions and switches the team.
import { esc, fmtTime, u } from '../core/layout.js';
import { getTeamService } from '../team.js';

const MARK = { edit: 'Edited · from the next round', add: 'Added · joins at the next round', remove: 'Removed · leaves at the next round' };
const VERB = { edit: 'edited', add: 'added', remove: 'removed' };
const PROTOCOL = { suggest: 'SUGGEST.md', implement: 'IMPLEMENT.md' };
const at = (iso) => fmtTime(String(iso || '').slice(0, 19).replace('T', ' '));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

function roleFields(role = {}, off = '') {
  return `<div class="role-fields">
      <label>Role name <input name="name" value="${esc(role.name || '')}" maxlength="100" required${off}></label>
      <label>Agents <input name="count" type="number" min="1" step="1" value="${esc(role.count || 1)}" required${off}></label>
      <label class="wide">Description <textarea class="explanation" name="description" rows="3" maxlength="8000" required${off}>${esc(role.description || '')}</textarea></label>
    </div>`;
}

function addCard(snapshot, off) {
  return `<section class="card">
    <h2>Add a role</h2>
    <p>Describe the work in your own words. At the next round an agent turns it into the role's instructions.</p>
    <form id="team-add-form" class="role-form" action="${u('/team/roles')}" method="POST">
      ${roleFields({}, off)}
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

function roleRow(item, snapshot, off) {
  const { row, was, role, change } = item;
  const id = esc(row.id);
  const pending = change === 'add' ? '<span class="muted">set at the next round</span>' : null;
  const authority = pending || (role ? esc(role.capabilities.includes('build') ? 'builds' : role.authority) : '—');
  const model = pending || (role ? `${esc(role.model || 'default')} / ${esc(role.effort || 'default')}` : 'default / default');
  const told = change ? '' : instructions(item, snapshot.isDefault);
  const stage = role?.stage && snapshot.team?.stages.length > 1 ? `<span class="role-stage muted">${esc(role.stage)}</span>` : '';
  const actions = change === 'remove' ? `<button type="button" data-team-undo="${id}"${off}>Undo</button>`
    : `<button type="button" data-team-edit="${id}"${off}>Edit</button>${change
      ? `<button type="button" data-team-undo="${id}"${off}>Undo</button>`
      : `<button type="button" class="danger" data-team-remove="${id}"${off}>Remove</button>`}`;
  const display = `<li class="item${change ? ` ch-${change}` : ''}" data-team-row="${id}">
    <span class="role-name"><strong>${esc(row.name)}</strong>${stage}</span>
    <span class="role-count">${row.count}</span>
    <span class="role-does">${change ? `<span class="tag">${MARK[change]}</span>` : ''}<span class="desc">${esc(row.description)}</span>${
      was ? `<span class="was"><b>Runs now:</b> ${esc(was.description)}${was.name !== row.name || was.count !== row.count ? ` (${esc(was.name)}, ${plural(was.count, 'agent')})` : ''}</span>` : ''}${
      told ? `<details class="instr"><summary>Instructions</summary><div class="instr-body">${told}</div></details>` : ''}</span>
    <span class="role-authority">${authority}</span>
    <span class="role-model">${model}</span>
    <span class="item-actions">${actions}</span>
  </li>`;
  if (change === 'remove') return display;
  return `${display}<li class="item editing" data-team-form="${id}" hidden>
    <form class="role-form">
      ${roleFields(row, off)}
      <div class="row"><button type="submit" class="primary"${off}>Save</button><button type="button" class="danger" data-team-cancel>Cancel</button>
        <span class="muted">Saved changes take effect from the next round.</span></div>
    </form>
  </li>`;
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

export function teamPage(snapshot, { autoApprove = false } = {}) {
  const off = !snapshot.available || snapshot.applying ? ' disabled' : '';
  const last = snapshot.lastApply;
  const failed = last?.status === 'failed' && snapshot.changes && !snapshot.applying;
  const cols = '<li class="cols" aria-hidden="true"><span>Role</span><span>Agents</span><span>Does</span><span>Authority</span><span>Model / effort</span><span>Action</span></li>';
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
      ${snapshot.changes ? `<div class="row waiting"><span><strong>${plural(snapshot.changes, 'change')}</strong> take${snapshot.changes === 1 ? 's' : ''} effect when the next round starts.</span>
        <button type="button" class="danger" data-team-undo-all${off}>Undo all</button></div>` : ''}
      <section class="queue-section team-ledger">
        <ul class="item-list">${cols}${snapshot.view.map((item) => roleRow(item, snapshot, off)).join('')}</ul>
      </section>
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
