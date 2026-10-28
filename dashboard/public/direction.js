// Direction notes and goal removal submit JSON through the same-origin routes.
(() => {
  'use strict';
  const page = document.querySelector('#direction-page');
  if (!page) return;
  const base = document.body.dataset.base || '';
  const error = document.querySelector('#direction-error');
  const showError = (message) => { error.textContent = message; error.hidden = false; };
  const send = async (control, path, body = {}) => {
    control.disabled = true;
    try {
      const response = await fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
      location.reload();
    } catch (failure) { showError(failure.message); control.disabled = false; }
  };

  const form = document.querySelector('#note-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(form.querySelector('[type="submit"]'), '/direction/notes', { body: form.querySelector('[name="body"]').value });
  });
  page.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.noteDelete) send(button, `/direction/notes/${encodeURIComponent(button.dataset.noteDelete)}/delete`);
    if (button.dataset.goalRemove) {
      send(button, '/direction/goals/remove', { index: Number(button.dataset.goalRemove), raw: button.dataset.goalRaw });
    }
  });

  // While a round reads the notes, wait for it and show the new goals.
  if (page.dataset.applying === '1') {
    const poll = async () => {
      try {
        const response = await fetch(base + '/direction/status');
        if (!response.ok) throw new Error(`Error ${response.status}`);
        if (!(await response.json()).applying) { location.reload(); return; }
      } catch (failure) { showError(failure.message); }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }
})();
