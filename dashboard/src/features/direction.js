// Direction: your notes about the project, and the goals they become in
// DIRECTION.md's Focus section. The next round reads waiting notes with the
// current goals and rewrites the list; Remove takes a goal out at once.
import { esc, fmtTime, u } from '../core/layout.js';
import { getDirectionService } from '../direction.js';

const at = (iso) => fmtTime(String(iso || '').slice(0, 19).replace('T', ' '));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const cols = (...names) => `<li class="cols" aria-hidden="true">${names.map((n) => `<span>${n}</span>`).join('')}</li>`;

function noteRows(notes, off) {
  if (!notes.length) return '<li class="muted empty">No notes yet.</li>';
  return cols('Written', 'Note', 'What happened', 'Action') + notes.map((note) => {
    const waiting = note.status === 'waiting';
    return `<li class="item${waiting ? ' waiting' : ''}">
      <span class="note-at">${esc(at(note.at))}</span>
      <span class="note-body">${esc(note.body)}</span>
      <span class="note-outcome">${waiting ? 'Waits for the next round' : `${esc(at(note.readAt))} round: ${esc(note.outcome)}`}</span>
      <span class="item-actions">${waiting ? `<button type="button" class="danger" data-note-delete="${note.id}"${off}>Delete</button>` : ''}</span>
    </li>`;
  }).join('');
}

function goalRows(goals, notes, off) {
  if (!goals.length) return '<li class="muted empty">No goals yet. Add a note, or write bullets under ## Focus in DIRECTION.md.</li>';
  const written = new Map(notes.map((note) => [note.id, note.at]));
  const from = (goal) => {
    if (!goal.from) return 'DIRECTION.md';
    const when = written.get(goal.from.notes[0]) || goal.from.at;
    return `${goal.from.notes.length > 1 ? 'Notes' : 'Note'}${when ? `, ${at(when).replace(/, \d\d:\d\d$/, '')}` : ''}`;
  };
  // A plain bullet without a title reads as one sentence across both columns.
  const mark = (goal) => (goal.mark ? ` <span class="muted">· ${goal.mark}</span>` : '');
  return cols('#', 'Goal', 'Agents work on', 'From', 'Action') + goals.map((goal) => `
    <li class="item">
      <span class="item-id"><span class="tag${goal.mark ? ' yours' : ''}">${goal.index + 1}</span></span>
      ${goal.title ? `<span class="goal-title"><strong>${esc(goal.title)}</strong>${mark(goal)}</span>
      <span class="goal-text">${esc(goal.text)}</span>` : `<span class="goal-title wide">${esc(goal.text)}${mark(goal)}</span>`}
      <span class="goal-from">${esc(from(goal))}</span>
      <span class="item-actions"><button type="button" class="danger" data-goal-remove="${goal.index}" data-goal-raw="${esc(goal.raw)}"${off}>Remove</button></span>
    </li>`).join('');
}

function status(snapshot) {
  const last = snapshot.lastApply;
  if (snapshot.applying) return '<p class="reader"><strong>The round is reading your notes now.</strong></p>';
  const waiting = snapshot.waiting
    ? `${plural(snapshot.waiting, 'new note')} wait${snapshot.waiting === 1 ? 's' : ''} for the next round.` : 'No notes wait.';
  const failed = last?.status === 'failed' && snapshot.waiting
    ? `<p class="error">The ${esc(at(last.finishedAt))} round could not read your notes (${esc(String(last.error).replace(/\.$/, ''))}). They still wait for the next round.${last.logs ? ` Logs: <code>${esc(last.logs)}</code>` : ''}</p>` : '';
  const used = snapshot.settings.applyModel || snapshot.settings.model || 'default';
  const effort = snapshot.settings.applyEffort || snapshot.settings.effort || 'default';
  return `<p class="reader muted">${waiting} Read by the interpreter (model ${esc(used)}, effort ${esc(effort)}), the same one the Team page uses.</p>${failed}`;
}

export function directionPage(snapshot) {
  const off = !snapshot.available || snapshot.applying ? ' disabled' : '';
  return `<div id="direction-page" data-applying="${snapshot.applying ? '1' : '0'}">
    <h1>Direction</h1>
    <p class="lead">Jot down anything you want from the project. At the start of the next round, the interpreter reads your new notes and updates the goals in DIRECTION.md. Agents work toward the goals from that round on.</p>
    ${!snapshot.available ? '<p class="error">Set SHOEMAKER_STATE to use the Direction page.</p>' : ''}
    ${snapshot.fileError ? `<p class="error">${esc(snapshot.fileError)}</p>` : ''}
    <section class="card">
      <h2>Your notes</h2>
      <form id="note-form" class="note-form">
        <textarea name="body" rows="3" maxlength="4000" required aria-label="New note" placeholder="An idea, a worry, something to stop doing… rough is fine."${off}></textarea>
        <div class="row"><button type="submit" class="primary"${off}>Add note</button></div>
      </form>
      ${status(snapshot)}
      <section class="queue-section notes">
        <ul class="item-list note-list">${noteRows(snapshot.notes, off)}</ul>
      </section>
      <p class="error" id="direction-error" role="alert" hidden></p>
    </section>
    <section class="queue-section goals">
      <h2>Goals <span class="count">${snapshot.goals.length}</span></h2>
      <p class="hint">Agents work toward these from the next round. Remove a goal to stop new work on it; ideas already in the queue stay until you reject them.</p>
      <ul class="item-list goal-list">${goalRows(snapshot.goals, snapshot.notes, off)}</ul>
    </section>
    <details class="queue-section archived file">
      <summary><h2>DIRECTION.md, as agents read it</h2></summary>
      <pre class="direction-file">${esc(snapshot.focus || '(no ## Focus section yet)')}</pre>
      <p class="muted small">The rest of the file (settings, constraints, feedback) stays as you wrote it. You can still edit it by hand; bullets you add under Focus show up here as goals.</p>
    </details>
  </div><script src="${u('/static/direction.js')}" defer></script>`;
}

function mutation(handler) {
  return async (ctx) => {
    try { await handler(ctx, getDirectionService()); ctx.json(200, { ok: true }); }
    catch (error) { ctx.json(error.status || 400, { error: error.message }); }
  };
}

export default {
  id: 'direction',
  order: 12,
  nav: { label: 'Direction', href: '/direction' },
  routes: [
    { method: 'GET', path: '/direction', handler: (ctx) => ctx.page({ title: 'Direction', body: directionPage(getDirectionService().status()) }) },
    { method: 'GET', path: '/direction/status', handler: (ctx) => ctx.json(200, getDirectionService().status()) },
    { method: 'POST', path: '/direction/notes', handler: mutation(async (ctx, service) => service.addNote(await ctx.body())) },
    { method: 'POST', path: '/direction/notes/:id/delete', handler: mutation(async (ctx, service) => service.deleteNote(Number(ctx.params.id))) },
    { method: 'POST', path: '/direction/goals/remove', handler: mutation(async (ctx, service) => {
      const { index, raw } = await ctx.body();
      if (!Number.isInteger(index) || typeof raw !== 'string') throw new Error('Send the goal index and its text.');
      service.removeGoal(index, raw);
    }) },
  ],
};
