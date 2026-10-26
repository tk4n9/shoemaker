// Vanilla client logic. Mutations go through fetch(JSON) then reload, keeping
// the server-rendered DOM as the single source of truth.
'use strict';

const BASE = document.body.dataset.base || ''; // subpath prefix, if any
function postJSON(url, body) {
  return fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// The page's own dialog, not the browser's alert/confirm/prompt: a browser can
// block those silently (after "don't show again", or in an in-app browser), and
// then a Reject did nothing. Resolves to the text typed ('' without a field),
// or null on Cancel or Escape.
function ask(message, { input = false, ok = 'OK', cancel = 'Cancel' } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'ask';
  dlg.innerHTML = `<form method="dialog"><p class="ask-text"></p>
    ${input ? '<textarea class="ask-input" rows="3"></textarea>' : ''}
    <div class="ask-actions">${cancel ? '<button value="cancel" type="submit">' + cancel + '</button>' : ''}
      <button value="ok" type="submit" class="ask-ok">${ok}</button></div></form>`;
  $('.ask-text', dlg).textContent = message;
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const text = dlg.returnValue === 'ok' ? ($('.ask-input', dlg)?.value.trim() ?? '') : null;
      dlg.remove();
      resolve(text);
    });
    dlg.showModal();
    ($('.ask-input', dlg) || $('.ask-ok', dlg)).focus();
  });
}
const tell = (message) => ask(message, { cancel: '' });

// POST, then reload; a refusal (e.g. a prerequisite loop) is shown as is.
async function postAndReload(url, body) {
  const res = await postJSON(url, body);
  if (!res.ok) {
    const out = await res.json().catch(() => ({}));
    await tell(out.error || `Error ${res.status}`);
    return;
  }
  location.reload();
}

// Markdown: use `marked` from CDN if reachable; otherwise fall back to <pre>.
// Specs are written by agents, so the HTML is cut down to plain formatting:
// no scripts, styles, event handlers or javascript: links.
let markedPromise = null;
async function renderMarkdown(text) {
  if (!markedPromise) {
    markedPromise = import('https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js')
      .then((m) => m.marked || m)
      .catch(() => null);
  }
  const marked = await markedPromise;
  return marked ? sanitize(marked.parse(text)) : plainText(text);
}

function plainText(text) {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<pre class="plain">${esc}</pre>`;
}

const ALLOWED = new Set(['P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'PRE', 'CODE', 'EM', 'STRONG', 'DEL', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'INPUT']);
function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node) => {
    for (const el of Array.from(node.children)) {
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(document.createTextNode(el.outerHTML));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const keep = (el.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:|#|\/)/i.test(attr.value))
          || (el.tagName === 'INPUT' && ['type', 'checked', 'disabled'].includes(attr.name));
        if (!keep) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') el.remove();
      if (el.tagName === 'A') { el.target = '_blank'; el.rel = 'noopener'; }
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

// ---------- Main page ----------
const projectName = $('#project-name');
if (projectName) {
  projectName.addEventListener('change', () =>
    postJSON('/config', { project_name: projectName.value }));
}

const toggleCompleted = $('#toggle-completed');
if (toggleCompleted) {
  toggleCompleted.addEventListener('click', async () => {
    const next = toggleCompleted.getAttribute('aria-pressed') !== 'true';
    await postJSON('/config', { show_completed: next });
    location.reload();
  });
}

const toggleAutoApprove = $('#toggle-auto-approve');
if (toggleAutoApprove) {
  toggleAutoApprove.addEventListener('click', async () => {
    const next = toggleAutoApprove.getAttribute('aria-checked') !== 'true';
    await postJSON('/config', { auto_approve: next });
    location.reload();
  });
}

// List / Graph view switch.
$$('.seg-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('active')) return;
    await postJSON('/config', { todo_view: btn.dataset.view });
    location.reload();
  });
});

const toggleAlign = $('#toggle-align');
if (toggleAlign) {
  const ORDER = ['left', 'center', 'right', 'fit'];
  toggleAlign.addEventListener('click', async () => {
    const cur = toggleAlign.getAttribute('data-align') || 'center';
    const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
    await postJSON('/config', { container_align: next });
    location.reload();
  });
}

const toggleTheme = $('#toggle-theme');
if (toggleTheme) {
  toggleTheme.addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    await postJSON('/config', { theme: next });
    location.reload(); // refresh the icon (sun/moon) and title
  });
}

const addForm = $('#add-form');
if (addForm) {
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#add-title').value.trim();
    if (!title) return;
    const approve = e.submitter?.dataset.approve === '1';
    const res = await postJSON('/todos', { title, approve, priority: Number($('#add-priority').value) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { await tell(out.error || `Error ${res.status}`); return; }
    // Added for review: open it, so you can write the spec before approving.
    if (approve) location.reload(); else location.href = `${BASE}/todos/${out.id}`;
  });
}

// ---------- Queue decisions (list rows and the detail page) ----------
// Every decision button is [data-action] inside an element with data-id.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const box = btn.closest('[data-id]');
  const id = box.dataset.id;
  const name = `#${id} "${box.dataset.title}"`;
  const priority = () => Number($('.js-priority', box)?.value ?? 0);
  switch (btn.dataset.action) {
    case 'approve':
      return postAndReload(`/todos/${id}/approve`, { priority: priority(), with_prereqs: btn.dataset.withPrereqs === '1' });
    case 'reject': {
      const started = ['in_progress', 'review'].includes(box.dataset.status)
        ? '\nIts branch and pull request, if any, stay as they are.' : '';
      const reason = await ask(`Reject and archive ${name}?${started}\n\n`
        + 'The suggestion agent will not suggest it again. Why? (optional; the agent reads this)', { input: true, ok: 'Reject' });
      if (reason === null) return;
      return postAndReload(`/todos/${id}/reject`, { reason });
    }
    case 'restore':
      return postAndReload(`/todos/${id}/restore`, {});
    case 'retry':
      return postAndReload(`/todos/${id}/retry`, {});
    case 'unapprove':
      return postAndReload(`/todos/${id}/unapprove`, {});
    case 'shipped':
      if (await ask(`Mark ${name} as shipped? Items that need it can then start.`, { ok: 'Mark shipped' }) === null) return;
      return postAndReload(`/todos/${id}/shipped`, {});
    case 'delete': {
      if (await ask(`Delete ${name} for good? Its spec and log are deleted too.`, { ok: 'Delete' }) === null) return;
      const res = await postJSON('/todos/delete', { ids: [Number(id)] });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { await tell(out.error || `Error ${res.status}`); return; }
      location.href = `${BASE}/todos`;
      return;
    }
    default:
  }
});

// An approved item's priority applies as soon as it is picked.
document.addEventListener('change', (e) => {
  const sel = e.target.closest('.js-priority[data-live]');
  if (!sel) return;
  postAndReload(`/todos/${sel.closest('[data-id]').dataset.id}/priority`, { priority: Number(sel.value) });
});

// ---------- Detail page ----------
const explanation = $('#explanation');
const saveExpl = $('#save-explanation');
if (saveExpl && explanation) {
  const todoId = location.pathname.replace(BASE, '').split('/')[2];

  // The title is a one-line textarea so a long title wraps: it grows to fit,
  // and Enter saves instead of starting a new line.
  const titleInput = $('#todo-title');
  if (titleInput) {
    const fit = () => {
      titleInput.style.height = 'auto';
      titleInput.style.height = `${titleInput.scrollHeight + titleInput.offsetHeight - titleInput.clientHeight}px`;
    };
    fit();
    titleInput.addEventListener('input', fit);
    window.addEventListener('resize', fit);
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
    });
    titleInput.addEventListener('change', () => {
      const v = titleInput.value.replace(/\s+/g, ' ').trim();
      if (v) postJSON(`/todos/${todoId}/title`, { title: v });
    });
  }

  saveExpl.addEventListener('click', async () => {
    await postJSON(`/todos/${todoId}/explanation`, { explanation: explanation.value });
    saveExpl.textContent = 'Saved ✓';
    setTimeout(() => { saveExpl.textContent = 'Save'; }, 1500);
  });

  const depsForm = $('#deps-form');
  if (depsForm) {
    depsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      postAndReload(`/todos/${todoId}/deps`, { deps: depsForm.elements.deps.value });
    });
  }

  // Write / Preview tabs. A spec that is already written opens as Preview.
  const preview = $('#preview');
  const showTab = async (which) => {
    $$('.md-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === which));
    const isPreview = which === 'preview';
    explanation.hidden = isPreview;
    preview.hidden = !isPreview;
    if (!isPreview) return;
    preview.innerHTML = plainText(explanation.value);   // at once, then formatted when marked loads
    preview.innerHTML = await renderMarkdown(explanation.value);
  };
  $$('.md-tabs .tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  if (preview.dataset.initial) showTab('preview');
}

// Comments / log (detail page).
const addCommentForm = $('#add-comment');
if (addCommentForm) {
  const cid = location.pathname.replace(BASE, '').split('/')[2];
  addCommentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = $('textarea[name="body"]', addCommentForm).value.trim();
    if (!body) return;
    await postJSON(`/todos/${cid}/comments`, { body });
    location.reload();
  });
}
$$('.comment .comment-delete').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = Number(btn.closest('.comment').dataset.id);
    if (await ask('Delete this comment?', { ok: 'Delete' }) === null) return;
    await postJSON(`/comments/${id}/delete`, {});
    location.reload();
  });
});
$$('.comment .comment-edit').forEach((ta) => {
  ta.addEventListener('change', () => {
    const id = Number(ta.closest('.comment').dataset.id);
    const body = ta.value.trim();
    if (body) postJSON(`/comments/${id}`, { body });
  });
});
