// The team page uses the dashboard's existing cards, forms and list styling.
import { esc, u } from '../core/layout.js';
import { getTeamService } from '../team.js';

function roleRow(role = {}, disabled = false) {
  const off = disabled ? ' disabled' : '';
  return `<li class="item" data-team-role>
    <div class="row">
      <label>Role name <input name="name" value="${esc(role.name || '')}" maxlength="100" required${off}></label>
      <label>Agents <input name="count" type="number" min="1" step="1" value="${esc(role.count || 1)}" required${off}></label>
      <button type="button" data-team-remove${off}>Remove role</button>
    </div>
    <label>Description <textarea class="explanation" name="description" rows="3" maxlength="8000" required${off}>${esc(role.description || '')}</textarea></label>
  </li>`;
}

function teamConfig(team) {
  if (!team) return '<p class="muted">No active team. Rounds use the standard suggestion and implementation agents.</p>';
  return `<ol>${team.stages.map((stage) => `<li>
    <h3>${esc(stage.name)}</h3>
    <ul class="item-list">${stage.roles.map((role) => `<li class="item">
      <div class="item-main"><strong>${esc(role.name)}</strong><span class="count">${role.count}</span></div>
      <dl class="facts">
        <dt>Stage</dt><dd>${esc(stage.name)}</dd>
        <dt>Capabilities</dt><dd>${role.capabilities.map(esc).join(', ')}</dd>
        <dt>Authority</dt><dd><strong>${esc(role.authority)}</strong>${role.authority === 'advisory' ? ' — the human decides' : role.authority === 'filter' ? ' — majority rejection screens ideas out' : ' — unanimous approval allows building'}</dd>
        <dt>Model / effort</dt><dd>${esc(role.model || 'DIRECTION.md default')} / ${esc(role.effort || 'DIRECTION.md default')}</dd>
      </dl>
      <p class="item-note">${esc(role.description)}</p>
      <details><summary>Generated instructions</summary><div class="preview md-body"><pre class="plain">${esc(role.instructions)}</pre></div></details>
    </li>`).join('')}</ul>
  </li>`).join('')}</ol>`;
}

export function teamPage(snapshot) {
  const latest = snapshot.interpretation;
  const usedSettings = latest?.model && latest?.effort ? ` Model: ${latest.model}; effort: ${latest.effort}.` : '';
  const running = latest?.status === 'running';
  const rows = snapshot.rows.length ? snapshot.rows : [{}];
  const disabled = running || !snapshot.available;
  return `<div id="team-page" data-team-running="${running ? '1' : '0'}" data-team-id="${esc(latest?.id || '')}">
    <h1>Team</h1>
    <section class="card">
      <h2>Describe your team</h2>
      <p>Give each role a count and describe its work. Apply prepares a preview; Confirm activates it for following rounds.</p>
      <p class="muted small">At most ${snapshot.maxAgents} agents per round. Reviewers are advisory unless you explicitly ask them to filter or approve ideas.</p>
      ${!snapshot.available ? '<p class="error">Set SHOEMAKER_STATE to configure this project’s team.</p>' : ''}
      <form id="team-form" action="${u('/team/apply')}" method="POST">
        <ul class="item-list" id="team-roles">${rows.map((row) => roleRow(row, disabled)).join('')}</ul>
        <div class="row">
          <button type="button" id="team-add"${disabled ? ' disabled' : ''}>Add role</button>
          <button type="submit"${disabled ? ' disabled' : ''}>Apply</button>
        </div>
      </form>
      <template id="team-role-template">${roleRow()}</template>
      <p class="error" id="team-error" role="alert" hidden></p>
    </section>
    <section class="card" aria-live="polite">
      <h2>Latest interpretation</h2>
      <p id="team-status">${latest ? esc({ running: 'Interpreting your team…', ready: 'Preview ready. Review the capabilities, authority and instructions before confirming.', failed: 'Interpretation failed.', confirmed: 'Confirmed. Following rounds use the active team.', discarded: 'Preview discarded.' }[latest.status] || latest.status) : 'No interpretation yet.'}${esc(usedSettings)}</p>
      ${latest?.error ? `<p class="error">${esc(latest.error)}</p>` : ''}
      ${latest?.logs ? `<p class="muted small">Logs: <code>${esc(latest.logs)}</code></p>` : ''}
      ${snapshot.proposed ? `${teamConfig(snapshot.proposed)}<div class="row">
        <button type="button" data-team-action="confirm">Confirm</button>
        <button type="button" class="danger" data-team-action="discard">Discard</button>
      </div>` : ''}
    </section>
    <section class="card">
      <h2>Active team</h2>
      ${snapshot.activeError ? `<p class="error">${esc(snapshot.activeError)}</p>` : teamConfig(snapshot.active)}
    </section>
  </div><script src="${u('/static/team.js')}" defer></script>`;
}

function mutation(handler) {
  return async (ctx) => {
    try { await handler(ctx, getTeamService()); }
    catch (error) { ctx.json(error.status || 400, { error: error.message }); }
  };
}

export default {
  id: 'team',
  order: 15,
  nav: { label: 'Team', href: '/team' },
  routes: [
    { method: 'GET', path: '/team', handler: (ctx) => ctx.page({ title: 'Team', body: teamPage(getTeamService().status()) }) },
    { method: 'GET', path: '/team/status', handler: (ctx) => ctx.json(200, getTeamService().status()) },
    { method: 'POST', path: '/team/apply', handler: mutation(async (ctx, service) => {
      const body = await ctx.body();
      if (Object.keys(body).some((key) => key !== 'rows')) throw new Error('Apply accepts only role rows.');
      ctx.json(202, { interpretation: service.apply(body.rows) });
    }) },
    { method: 'POST', path: '/team/confirm', handler: mutation(async (ctx, service) => {
      const body = await ctx.body();
      ctx.json(200, { active: service.confirm(body.id) });
    }) },
    { method: 'POST', path: '/team/discard', handler: mutation(async (ctx, service) => {
      const body = await ctx.body();
      service.discard(body.id);
      ctx.json(200, { ok: true });
    }) },
  ],
};
