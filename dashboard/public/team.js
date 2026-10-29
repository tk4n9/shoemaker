// Team changes submit JSON through the same-origin dashboard routes. Edit
// opens a role's row in place; every saved change waits for the next round.
(() => {
  'use strict';
  const page = document.querySelector('#team-page');
  if (!page) return;
  const base = document.body.dataset.base || '';
  const error = document.querySelector('#team-error');
  const showError = (message) => { error.textContent = message; error.hidden = false; };
  const submit = async (path, body = {}) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    location.reload();
  };
  const fields = (form) => ({
    name: form.querySelector('[name="name"]').value,
    count: Number(form.querySelector('[name="count"]').value),
    description: form.querySelector('[name="description"]').value,
    model: form.querySelector('[name="model"]').value,
    effort: form.querySelector('[name="effort"]').value,
  });
  // A description field grows with its text, like the row it replaces.
  const fit = (area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
  page.addEventListener('input', (event) => { if (event.target.matches('.editing textarea')) fit(event.target); });
  const row = (id) => page.querySelector(`[data-team-row="${CSS.escape(id)}"]`);
  const send = async (control, path, body) => {
    control.disabled = true;
    try { await submit(path, body); }
    catch (failure) { showError(failure.message); control.disabled = false; }
  };
  const role = (id) => `/team/roles/${encodeURIComponent(id)}`;

  const add = document.querySelector('#team-add-form');
  add.addEventListener('submit', (event) => {
    event.preventDefault();
    send(add.querySelector('[type="submit"]'), '/team/roles', fields(add));
  });

  page.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const { teamEdit, teamRemove, teamUndo } = button.dataset;
    if (teamEdit) {
      row(teamEdit).hidden = true;
      const editor = page.querySelector(`[data-team-form="${CSS.escape(teamEdit)}"]`);
      editor.hidden = false;
      fit(editor.querySelector('textarea'));
      editor.querySelector('[name="name"]').focus();
    } else if ('teamCancel' in button.dataset) {
      const editor = button.closest('[data-team-form]');
      editor.hidden = true;
      editor.querySelector('form').reset();
      row(editor.dataset.teamForm).hidden = false;
    } else if (teamRemove) send(button, `${role(teamRemove)}/remove`);
    else if (teamUndo) send(button, `${role(teamUndo)}/undo`);
    else if ('teamUndoAll' in button.dataset) send(button, '/team/undo');
  });
  page.addEventListener('submit', (event) => {
    const editor = event.target.closest('[data-team-form]');
    if (!editor) return;
    event.preventDefault();
    send(editor.querySelector('[type="submit"]'), role(editor.dataset.teamForm), fields(event.target));
  });

  // While a round applies the changes, wait for it and show the result.
  if (page.dataset.applying === '1') {
    const poll = async () => {
      try {
        const response = await fetch(base + '/team/status');
        if (!response.ok) throw new Error(`Error ${response.status}`);
        if (!(await response.json()).applying) { location.reload(); return; }
      } catch (failure) { showError(failure.message); }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }
})();
