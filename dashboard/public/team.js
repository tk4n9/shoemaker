// Team forms submit JSON through the same-origin dashboard routes.
(() => {
  'use strict';
  const page = document.querySelector('#team-page');
  if (!page) return;
  const base = document.body.dataset.base || '';
  const form = document.querySelector('#team-form');
  const roles = document.querySelector('#team-roles');
  const error = document.querySelector('#team-error');
  const showError = (message) => { error.textContent = message; error.hidden = false; };
  const submit = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    location.reload();
  };

  document.querySelector('#team-add').addEventListener('click', () => {
    const template = document.querySelector('#team-role-template');
    roles.append(template.content.cloneNode(true));
    roles.lastElementChild.querySelector('[name="name"]').focus();
  });
  roles.addEventListener('click', (event) => {
    const button = event.target.closest('[data-team-remove]');
    if (button) button.closest('[data-team-role]').remove();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const rows = Array.from(roles.querySelectorAll('[data-team-role]'), (row) => ({
      name: row.querySelector('[name="name"]').value,
      count: Number(row.querySelector('[name="count"]').value),
      description: row.querySelector('[name="description"]').value,
    }));
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try { await submit('/team/apply', { rows }); }
    catch (failure) { showError(failure.message); button.disabled = false; }
  });
  page.querySelectorAll('[data-team-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await submit(`/team/${button.dataset.teamAction}`, { id: page.dataset.teamId }); }
      catch (failure) { showError(failure.message); button.disabled = false; }
    });
  });

  if (page.dataset.teamRunning === '1') {
    const poll = async () => {
      try {
        const response = await fetch(base + '/team/status');
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const current = await response.json();
        if (current.interpretation?.status !== 'running') { location.reload(); return; }
      } catch (failure) { showError(failure.message); }
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1500);
  }
})();
