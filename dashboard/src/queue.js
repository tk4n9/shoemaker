import { createHash } from 'node:crypto';

// The agent queue: todos as work items passed between a suggestion agent, the
// human, and an implementation agent. The repository's docs/queue.md is the contract.
//
//   suggestion agent ─ add ─▶ proposed ─ human approves ─▶ approved
//   implementation agent ─ claim ─▶ in_progress ─▶ shipped | review | failed
//   human rejects ─▶ archived (restorable)
//
// An approved item is *ready* once every prerequisite (todo_deps) has shipped;
// only ready items are handed to the implementation agent. Everything here is
// shared by the web UI (src/features/*) and the agents' CLI (bin/queue.mjs);
// each surface exposes only its own moves.

export const STATUSES = ['proposed', 'approved', 'in_progress', 'review', 'shipped', 'failed', 'archived'];

export const STATUS_LABEL = {
  proposed: 'Waiting for your review',
  approved: 'Approved',
  in_progress: 'In progress',
  review: 'Waiting for your merge',
  shipped: 'Shipped',
  failed: 'Failed',
  archived: 'Archived',
};

// Auto (0) takes the priority the suggestion agent recommended, else Normal.
export const PRIORITIES = [0, 1, 2, 3];
export const PRIORITY_LABEL = { 0: 'Auto', 1: 'High', 2: 'Normal', 3: 'Low' };
const PRIORITY_WORDS = { auto: 0, high: 1, normal: 2, low: 3 };

// An item the implementation agent has picked up this many times without
// finishing is marked failed instead of being picked up again.
export const MAX_ATTEMPTS = 3;

const MOVES = {
  proposed: ['approved', 'archived'],
  approved: ['proposed', 'in_progress', 'shipped', 'archived'],
  in_progress: ['in_progress', 'review', 'shipped', 'failed', 'approved', 'archived'],
  review: ['shipped', 'failed', 'in_progress', 'archived'],
  failed: ['approved', 'shipped', 'archived'],
  archived: ['proposed'],
  shipped: [],
};

// A refusal with a message fit for the person or agent that asked (HTTP 400, CLI exit 1).
export class QueueError extends Error {}

// Same format as SQLite's datetime('now'): UTC 'YYYY-MM-DD HH:MM:SS'.
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function parsePriority(p) {
  const n = PRIORITY_WORDS[String(p).trim().toLowerCase()] ?? Number(p);
  if (!PRIORITIES.includes(n)) throw new QueueError(`priority must be auto, high, normal or low, not "${p}"`);
  return n;
}

// The suggestion agent's recommendation: high, normal or low (never auto).
export function parseSuggestedPriority(p) {
  const n = parsePriority(p);
  if (n === 0) throw new QueueError('a suggested priority must be high, normal or low');
  return n;
}

// The priority an item is built at, before prerequisites inherit anything.
export const basePriority = (t) => t.priority || t.suggested_priority || 2;

// "High", or "Auto (High)" when Auto picked it.
export const priorityWords = (t) => (t.priority ? PRIORITY_LABEL[t.priority] : `Auto (${PRIORITY_LABEL[basePriority(t)]})`);

// "3, #5 7" or [3, 5] → [3, 5, 7].
export function parseIds(input) {
  if (input == null || input === '') return [];
  const parts = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const ids = [];
  for (const p of parts) {
    if (p === '' || p == null) continue;
    const m = String(p).trim().match(/^#?(\d+)$/);
    if (!m) throw new QueueError(`not an item id: "${p}"`);
    if (!ids.includes(Number(m[1]))) ids.push(Number(m[1]));
  }
  return ids;
}

// Pull request links are drawn as links on the page, so only web addresses pass.
function checkUrl(url) {
  if (url && !/^https?:\/\/\S+$/i.test(String(url))) throw new QueueError(`not a web address: "${url}"`);
  return url;
}

// A short name for a pull request link: "!123" (GitLab), "#123" (GitHub), else "PR".
export function prName(url) {
  const gl = /\/merge_requests\/(\d+)/.exec(url);
  if (gl) return `!${gl[1]}`;
  const gh = /\/pull\/(\d+)/.exec(url);
  return gh ? `#${gh[1]}` : 'PR';
}

export function getItem(db, id) {
  return db.prepare('SELECT * FROM todos WHERE id = ?').get(Number(id));
}

function mustGet(db, id) {
  const t = getItem(db, id);
  if (!t) throw new QueueError(`no item #${id}`);
  return t;
}

export function log(db, id, body, author = 'you') {
  db.prepare('INSERT INTO comments (todo_id, body, author) VALUES (?, ?, ?)').run(Number(id), body, author);
}

export function itemLog(db, id) {
  return db.prepare('SELECT * FROM comments WHERE todo_id = ? ORDER BY id ASC').all(Number(id));
}

// ---------- The whole queue, annotated ----------

// Every item with its prerequisites (deps), the items that need it (dependents),
// the prerequisites it still waits for (blockers), whether it is ready, and its
// effective priority: a prerequisite inherits the priority of the approved work
// that waits on it, so approving C as High pulls its A and B forward too.
export function loadState(db) {
  const rows = db.prepare('SELECT * FROM todos ORDER BY id').all();
  const byId = new Map(rows.map((t) => [t.id, { ...t, deps: [], dependents: [] }]));
  for (const { todo_id, dep_id } of db.prepare('SELECT todo_id, dep_id FROM todo_deps ORDER BY dep_id').all()) {
    const t = byId.get(todo_id);
    const d = byId.get(dep_id);
    if (t && d) { t.deps.push(dep_id); d.dependents.push(todo_id); }
  }
  for (const t of byId.values()) {
    t.blockers = t.deps.filter((d) => byId.get(d).status !== 'shipped');
    t.ready = t.status === 'approved' && t.blockers.length === 0;
    t.base_priority = basePriority(t);
    t.effective_priority = t.base_priority;
  }
  for (const t of byId.values()) {
    if (t.status !== 'approved') continue;
    const seen = new Set();
    const stack = [...t.deps];
    while (stack.length) {
      const d = byId.get(stack.pop());
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      if (d.status === 'shipped' || d.status === 'archived') continue;
      d.effective_priority = Math.min(d.effective_priority, t.base_priority);
      stack.push(...d.deps);
    }
  }
  return { items: [...byId.values()], byId };
}

// Implementation order among ready items: effective priority, then approval time.
const byQueueOrder = (a, b) => a.effective_priority - b.effective_priority
  || String(a.approved_at || '').localeCompare(String(b.approved_at || '')) || a.id - b.id;

// What the implementation agent works on next: an item it already started
// (resumed first), else the first ready item. Pure: claims nothing.
export function nextItem(db, { state = loadState(db), includeExhausted = false } = {}) {
  const started = state.items
    .filter((t) => t.status === 'in_progress' && (includeExhausted || t.attempts < MAX_ATTEMPTS))
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.id - b.id);
  if (started.length) return { item: started[0], resume: true, state };
  const ready = state.items.filter((t) => t.ready).sort(byQueueOrder);
  if (ready.length) return { item: ready[0], resume: false, state };
  return { item: null, resume: false, why: whyNothing(state), state };
}

// The files an item's spec names in its Files part (`**Files:**`, `**Files.**`,
// `## Files`, …, up to the next blank line or heading), in backticks. Two items
// that name the same file (or one inside the other's folder) are not built at
// the same time. A spec with no Files part names nothing.
export function specFiles(t) {
  const out = new Set();
  let inFiles = false;
  let seen = false; // a blank line ends the part only after some of its text
  for (const line of String(t.explanation || '').split('\n')) {
    const head = /^\s*(?:[-*]\s+)?(?:#+\s*)?\**([A-Za-z][\w ]*?)\s*[:.]?\**[:.]?(?:\s|$)/.exec(line);
    const isHead = head && (/^\s*#/.test(line) || /^\s*(?:[-*]\s+)?\*\*/.test(line));
    if (isHead) { inFiles = /^files$/i.test(head[1].trim()); seen = false; }
    else if (!line.trim()) { if (seen) inFiles = false; continue; }
    if (!inFiles) continue;
    if (!isHead || line.replace(head[0], '').trim()) seen = true;
    for (const [, code] of line.matchAll(/`([^`]+)`/g)) {
      const raw = code.trim().replace(/:\d+(?:[-–]\d+)?$/, ''); // file.js:111 → file.js
      if (!/\/|\.[A-Za-z0-9]+$/.test(raw) || /\s/.test(raw)) continue;
      out.add(raw.replace(/^\.\//, '').replace(/\/\*\*(\/\*)?$/, '').replace(/\/+$/, ''));
    }
  }
  return [...out];
}

const sameArea = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export const filesOverlap = (fa, fb) => fa.some((a) => fb.some((b) => sameArea(a, b)));

// Up to `max` items to build side by side, in nextItem's order (started ones
// first), skipping any whose files overlap one already chosen. Pure.
export function nextItems(db, max, { state = loadState(db), exclude = [] } = {}) {
  const started = state.items
    .filter((t) => t.status === 'in_progress' && t.attempts < MAX_ATTEMPTS)
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.id - b.id)
    .map((item) => ({ item, resume: true }));
  const ready = state.items.filter((t) => t.ready).sort(byQueueOrder).map((item) => ({ item, resume: false }));
  const chosen = [];
  const held = [];
  for (const c of [...started, ...ready]) {
    if (exclude.includes(c.item.id)) continue;
    if (chosen.length >= max) break;
    const files = specFiles(c.item);
    if (held.some((h) => filesOverlap(h.files, files))) continue;
    chosen.push(c);
    held.push({ id: c.item.id, files });
  }
  return { items: chosen, why: chosen.length ? null : whyNothing(state), state };
}

// The approved items in the order they will be built: ready ones by queue
// order, then those still waiting for a prerequisite.
export function approvedInOrder(state) {
  const approved = state.items.filter((t) => t.status === 'approved');
  return [...approved.filter((t) => t.ready).sort(byQueueOrder), ...approved.filter((t) => !t.ready).sort(byQueueOrder)];
}

export function blockerWords(state, id) {
  const d = state.byId.get(id);
  return `#${id} (${d.status === 'proposed' ? 'not approved yet' : STATUS_LABEL[d.status].toLowerCase()})`;
}

export function whyNothing(state) {
  const count = (s) => state.items.filter((t) => t.status === s).length;
  const approved = state.items.filter((t) => t.status === 'approved');
  if (!approved.length) {
    const waiting = count('proposed');
    return waiting ? `nothing is approved; ${waiting} waiting for your review` : 'the queue is empty';
  }
  const waits = approved.slice(0, 5).map((t) => `#${t.id} needs ${t.blockers.map((b) => blockerWords(state, b)).join(', ')}`);
  return `${approved.length} approved, but each waits for a prerequisite: ${waits.join('; ')}${approved.length > 5 ? '; …' : ''}`;
}

export function stats(db, state = loadState(db)) {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of state.items) out[t.status]++;
  out.ready = state.items.filter((t) => t.ready).length;
  out.total = state.items.length;
  return out;
}

// Prerequisites an item still needs approved: its proposed ancestors, nearest first.
export function unapprovedPrereqs(state, id) {
  const out = [];
  const seen = new Set();
  const queue = [...state.byId.get(id).deps];
  while (queue.length) {
    const d = state.byId.get(queue.shift());
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    if (d.status === 'proposed') out.push(d.id);
    if (d.status !== 'shipped') queue.push(...d.deps);
  }
  return out;
}

// ---------- Changes ----------

function update(db, id, fields) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE todos SET ${cols.map((c) => `${c} = ?, `).join('')}updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), now(), Number(id));
}

function setStatus(db, t, to, fields = {}) {
  if (!MOVES[t.status].includes(to)) {
    throw new QueueError(`#${t.id} is ${STATUS_LABEL[t.status].toLowerCase()}; it cannot become ${STATUS_LABEL[to].toLowerCase()}`);
  }
  const stamp = { approved: 'approved_at', shipped: 'shipped_at', archived: 'archived_at' }[to];
  const set = { status: to, done: to === 'shipped' ? 1 : 0, ...(stamp ? { [stamp]: now() } : {}), ...fields };
  const cols = Object.keys(set);
  // Only from the status we read: if the page and an agent move the same item at once, one of them is refused.
  const changed = db.prepare(`UPDATE todos SET ${cols.map((c) => `${c} = ?, `).join('')}updated_at = ? WHERE id = ? AND status = ?`)
    .run(...cols.map((c) => set[c]), now(), t.id, t.status).changes;
  if (!changed) throw new QueueError(`#${t.id} changed meanwhile; reload and try again`);
}

// Retry and Restore start an item afresh: an earlier attempt's branch and pull
// request move into the log (a closed PR must not fail the new attempt).
function forgetAttempt(db, t, author) {
  const parts = [t.branch && `branch ${t.branch}`, t.pr_url && `pull request ${t.pr_url}`].filter(Boolean);
  if (!parts.length) return {};
  log(db, t.id, `Earlier attempt: ${parts.join(', ')}. The next attempt may reuse what is still sound in it.`, author);
  return { branch: null, pr_url: null };
}

// Throws unless `deps` may be the prerequisites of item `id` (null for a new item).
function checkDeps(db, id, deps) {
  const state = loadState(db);
  for (const d of deps) {
    const dep = state.byId.get(d);
    if (!dep) throw new QueueError(`no item #${d}`);
    if (d === id) throw new QueueError(`#${d} cannot need itself`);
    if (dep.status === 'archived') throw new QueueError(`#${d} is archived (rejected); nothing can build on it`);
    if (id == null) continue;
    const stack = [d];
    const seen = new Set();
    while (stack.length) {
      const cur = state.byId.get(stack.pop());
      if (cur.id === id) throw new QueueError(`#${d} already needs #${id}, directly or through others; that would be a loop`);
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      stack.push(...cur.deps);
    }
  }
}

function writeDeps(db, id, deps) {
  db.prepare('DELETE FROM todo_deps WHERE todo_id = ?').run(id);
  const ins = db.prepare('INSERT INTO todo_deps (todo_id, dep_id) VALUES (?, ?)');
  for (const d of deps) ins.run(id, d);
}

const ids = (list) => list.map((d) => `#${d}`).join(', ');

// `suggestedPriority` is the suggestion agent's recommendation, used while the item's priority is Auto.
export function addItem(db, { title, body = '', deps = [], source = 'you', runId = null, author = 'you', suggestedPriority = null }) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new QueueError('title required');
  if (clean.length > 200) throw new QueueError('title is longer than 200 characters; put the detail in the body');
  const same = db.prepare('SELECT id, status FROM todos WHERE lower(title) = lower(?)').get(clean);
  if (same) throw new QueueError(`#${same.id} (${STATUS_LABEL[same.status].toLowerCase()}) already has this title`);
  const depIds = parseIds(deps);
  const sp = suggestedPriority == null || suggestedPriority === '' ? null : parseSuggestedPriority(suggestedPriority);
  return db.transaction(() => {
    checkDeps(db, null, depIds);
    const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM todos').get().m;
    const id = Number(db.prepare(
      'INSERT INTO todos (title, explanation, position, source, run_id, priority, suggested_priority, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(clean, body, max + 1, source, runId, sp, now()).lastInsertRowid);
    writeDeps(db, id, depIds);
    const from = source === 'you' ? 'Added by you.'
      : `Suggested by the ${source}${runId ? ` (run ${runId})` : ''}${sp ? `, at ${PRIORITY_LABEL[sp]} priority` : ''}.`;
    log(db, id, depIds.length ? `${from} Builds on ${ids(depIds)}.` : from, author);
    return id;
  })();
}

export function setDeps(db, id, deps, author = 'you') {
  const t = mustGet(db, id);
  if (['shipped', 'archived'].includes(t.status)) throw new QueueError(`#${t.id} is ${t.status}; its prerequisites are final`);
  const depIds = parseIds(deps);
  db.transaction(() => {
    checkDeps(db, t.id, depIds);
    writeDeps(db, t.id, depIds);
    update(db, t.id, {});
    log(db, t.id, depIds.length ? `Prerequisites set to ${ids(depIds)}.` : 'Prerequisites cleared.', author);
  })();
}

// --- the human's moves (web UI) ---

// Approve an item; with `withPrereqs`, also every prerequisite still waiting for review.
export function approve(db, id, priority, { withPrereqs = false, author = 'you' } = {}) {
  const p = parsePriority(priority);
  db.transaction(() => {
    const t = mustGet(db, id);
    const extra = withPrereqs ? unapprovedPrereqs(loadState(db), t.id) : [];
    setStatus(db, t, 'approved', { priority: p });
    log(db, t.id, `Approved, priority ${priorityWords({ ...t, priority: p })}${extra.length ? `, with its prerequisites ${ids(extra)}` : ''}.`, author);
    for (const d of extra) {
      const dt = mustGet(db, d);
      setStatus(db, dt, 'approved', { priority: p });
      log(db, d, `Approved, priority ${priorityWords({ ...dt, priority: p })}, as a prerequisite of #${t.id}.`, author);
    }
  })();
}

export function setPriority(db, id, priority, author = 'you') {
  const p = parsePriority(priority);
  const t = mustGet(db, id);
  if (t.priority === p) return;
  update(db, t.id, { priority: p });
  log(db, t.id, `Priority set to ${priorityWords({ ...t, priority: p })}.`, author);
}

export function unapprove(db, id, author = 'you') {
  const t = mustGet(db, id);
  setStatus(db, t, 'proposed', { approved_at: null, auto_approval_blocked: 1 });
  log(db, t.id, 'Moved back to review.', author);
}

export function archive(db, id, reason = '', author = 'you') {
  const t = mustGet(db, id);
  const why = String(reason || '').trim();
  setStatus(db, t, 'archived', { status_note: why || null });
  log(db, t.id, `Rejected and archived.${why ? ` Reason: ${why}` : ''}`, author);
}

export function restore(db, id, author = 'you') {
  db.transaction(() => {
    const t = mustGet(db, id);
    setStatus(db, t, 'proposed', { approved_at: null, status_note: null, attempts: 0, auto_approval_blocked: 1, ...forgetAttempt(db, t, author) });
    log(db, t.id, 'Restored for review.', author);
  })();
}

export function retry(db, id, author = 'you') {
  db.transaction(() => {
    const t = mustGet(db, id);
    setStatus(db, t, 'approved', { attempts: 0, status_note: null, approved_at: t.approved_at, ...forgetAttempt(db, t, author) });
    log(db, t.id, 'Approved again for another try.', author);
  })();
}

// --- the agents' moves (bin/queue.mjs) ---

export function claim(db, id, runId, author = 'agent') {
  return db.transaction(() => {
    const t = mustGet(db, id);
    if (t.status === 'approved') {
      const state = loadState(db);
      const blockers = state.byId.get(t.id).blockers;
      if (blockers.length) throw new QueueError(`#${t.id} still needs ${blockers.map((b) => blockerWords(state, b)).join(', ')}`);
      setStatus(db, t, 'in_progress', { attempts: t.attempts + 1, last_run: runId, status_note: null });
    } else if (t.status === 'in_progress') {
      setStatus(db, t, 'in_progress', { attempts: t.attempts + 1, last_run: runId });
    } else {
      throw new QueueError(`#${t.id} is ${STATUS_LABEL[t.status].toLowerCase()}; only an approved or started item can be picked up`);
    }
    log(db, t.id, `Picked up by run ${runId} (attempt ${t.attempts + 1} of ${MAX_ATTEMPTS}).`, author);
    return getItem(db, t.id);
  })();
}

// Take the next item and claim it in one step; a started item that has used
// up its attempts is marked failed on the way.
export function pick(db, runId, author = 'agent') {
  for (;;) {
    const next = nextItem(db, { includeExhausted: true });
    if (!next.item) return next;
    if (next.resume && next.item.attempts >= MAX_ATTEMPTS) {
      fail(db, next.item.id, `gave up after ${next.item.attempts} rounds without finishing`, author);
      continue;
    }
    return { ...next, item: claim(db, next.item.id, runId, author) };
  }
}

// Take up to `max` items and claim them, for builds side by side (nextItems).
export function pickMany(db, runId, max, author = 'agent', { exclude = [] } = {}) {
  for (const t of loadState(db).items) {
    if (t.status === 'in_progress' && t.attempts >= MAX_ATTEMPTS) fail(db, t.id, `gave up after ${t.attempts} rounds without finishing`, author);
  }
  const next = nextItems(db, max, { exclude });
  return { ...next, items: next.items.map((c) => ({ ...c, item: claim(db, c.item.id, runId, author) })) };
}

// Give back an attempt the agent never used (it could not start: a usage limit,
// a broken install). A first attempt with nothing to show returns to the queue.
export function release(db, id, note, author = 'agent') {
  const why = String(note || '').trim();
  if (!why) throw new QueueError('say why the attempt is given back');
  db.transaction(() => {
    const t = mustGet(db, id);
    if (t.status !== 'in_progress') throw new QueueError(`#${t.id} is not in progress`);
    const attempts = Math.max(0, t.attempts - 1);
    if (attempts === 0 && !t.branch && !t.pr_url) setStatus(db, t, 'approved', { attempts, approved_at: t.approved_at });
    else setStatus(db, t, 'in_progress', { attempts });
    log(db, t.id, `Attempt given back: ${why}`, author);
  })();
}

export function setLinks(db, id, { branch, pr } = {}, author = 'agent') {
  checkUrl(pr);
  const t = mustGet(db, id);
  if (!['in_progress', 'review'].includes(t.status)) throw new QueueError(`#${t.id} is not in progress`);
  const fields = {};
  if (branch && branch !== t.branch) fields.branch = branch;
  if (pr && pr !== t.pr_url) fields.pr_url = pr;
  if (!Object.keys(fields).length) return;
  update(db, t.id, fields);
  if (fields.branch) log(db, t.id, `Branch: ${fields.branch}`, author);
  if (fields.pr_url) log(db, t.id, `Pull request: ${fields.pr_url}`, author);
}

export function toReview(db, id, pr, author = 'agent') {
  checkUrl(pr);
  const t = mustGet(db, id);
  setStatus(db, t, 'review', pr ? { pr_url: pr } : {});
  log(db, t.id, `Draft pull request waiting for your merge${pr ? `: ${pr}` : '.'}`, author);
}

// The implementation agent ships only the item it is working on.
export function ship(db, id, { pr, note } = {}, author = 'agent') {
  checkUrl(pr);
  const t = mustGet(db, id);
  if (!['in_progress', 'review'].includes(t.status)) {
    throw new QueueError(`#${t.id} is ${STATUS_LABEL[t.status].toLowerCase()}; only an item in progress or waiting for a merge can ship`);
  }
  setStatus(db, t, 'shipped', { ...(pr ? { pr_url: pr } : {}), status_note: null });
  const link = pr || t.pr_url;
  log(db, t.id, `Shipped${link ? `: ${link}` : '.'}${note ? ` ${note}` : ''}`, author);
}

// The runner saw the item's pull request merged on the forge. That also
// settles a failed item whose PR merged after all.
export function merged(db, id, { pr, note } = {}, author = 'run.sh') {
  checkUrl(pr);
  const t = mustGet(db, id);
  if (!['in_progress', 'review', 'failed'].includes(t.status)) {
    throw new QueueError(`#${t.id} is ${STATUS_LABEL[t.status].toLowerCase()}; its merge cannot be recorded`);
  }
  setStatus(db, t, 'shipped', { ...(pr ? { pr_url: pr } : {}), status_note: null });
  const link = pr || t.pr_url;
  log(db, t.id, `Merged${link ? `: ${link}` : '.'}${note ? ` ${note}` : ''}`, author);
}

export function fail(db, id, note, author = 'agent') {
  const why = String(note || '').trim();
  if (!why) throw new QueueError('say why it failed');
  const t = mustGet(db, id);
  setStatus(db, t, 'failed', { status_note: why });
  log(db, t.id, `Failed: ${why}`, author);
}

export function markShipped(db, id, author = 'you') {
  const t = mustGet(db, id);
  setStatus(db, t, 'shipped', { status_note: null });
  log(db, t.id, 'Marked shipped by you.', author);
}

// Team reviews remain separate from build/merge review. No review can move an
// item the human has already acted on; BEGIN IMMEDIATE serializes with the UI.
export function agentReview(db, id, { run_id, stage_id, role_id, agent_id, authority, verdict, body, author = `${stage_id}/${agent_id}`, recordNote = true }) {
  if (!['advisory', 'filter', 'approve'].includes(authority)) throw new QueueError('invalid reviewer authority');
  if (!['approve', 'reject', 'abstain'].includes(verdict)) throw new QueueError('invalid reviewer verdict');
  if (typeof body !== 'string' || !body.trim() || body.length > 24000) throw new QueueError('a review needs a reason (at most 24000 characters)');
  return db.transaction(() => {
    const t = mustGet(db, id);
    if (t.status !== 'proposed') return false;
    db.prepare(`INSERT INTO agent_reviews (todo_id, run_id, stage_id, role_id, agent_id, authority, verdict, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (todo_id, run_id, stage_id, agent_id)
      DO UPDATE SET verdict = excluded.verdict, body = excluded.body, created_at = datetime('now')`)
      .run(t.id, run_id, stage_id, role_id, agent_id, authority, verdict, body.trim());
    if (recordNote) log(db, t.id, `Agent review [${authority}] ${verdict}: ${body.trim()}`, author);
    return true;
  }).immediate();
}

// A hold covers the spec, prerequisites and notes the approver actually read.
// Its own notes do not make that input new work on the following round.
// The basis keeps only the human's notes: team reviewers write while the
// approver runs, and that alone must not void its decision.
const humanNote = (c) => c.author === 'you';
function approvalFingerprint(db, item, state, keep = (c) => c.author !== 'auto-approval agent') {
  const notes = (id) => itemLog(db, id).filter(keep).map((c) => [c.id, c.author, c.body]);
  const dependencies = new Map(), pending = [...item.deps];
  while (pending.length) {
    const dep = state.byId.get(pending.pop());
    if (!dep || dependencies.has(dep.id)) continue;
    dependencies.set(dep.id, [dep.id, dep.status, dep.title, dep.explanation, dep.deps, notes(dep.id)]);
    if (dep.status !== 'shipped') pending.push(...dep.deps);
  }
  return createHash('sha256').update(JSON.stringify([item.title, item.explanation, item.deps, notes(item.id),
    [...dependencies.values()].sort((a, b) => a[0] - b[0])])).digest('hex');
}

export function approvalSnapshot(db) {
  return db.transaction(() => {
    const state = loadState(db);
    const held = new Map(db.prepare('SELECT * FROM auto_approval_holds').all().map((h) => [h.todo_id, h.fingerprint]));
    const items = state.items.filter((t) => t.status === 'proposed' && !t.auto_approval_blocked).map((t) => ({
      id: t.id, title: t.title, spec: t.explanation, deps: t.deps, blockers: t.blockers,
      prerequisites: t.deps.map((id) => ({ id, title: state.byId.get(id).title, status: state.byId.get(id).status })),
      suggested_priority: t.suggested_priority, fingerprint: approvalFingerprint(db, t, state),
      basis: approvalFingerprint(db, t, state, humanNote),
      log: itemLog(db, t.id).map((c) => ({ at: c.created_at, by: c.author, text: c.body })),
    })).filter((t) => held.get(t.id) !== t.fingerprint);
    return { enabled: Boolean(db.prepare('SELECT auto_approve FROM config WHERE id = 1').get().auto_approve), items };
  })();
}

export function applyAutoApprovals(db, context, reviews) {
  if (context.authority !== 'approve' || context.capabilities.length !== 1 || context.capabilities[0] !== 'review'
    || !Array.isArray(context.items) || new Set(context.items.map((t) => t.id)).size !== context.items.length
    || context.items.some((t) => !Number.isSafeInteger(t.id) || ![t.fingerprint, t.basis].every((h) => /^[a-f0-9]{64}$/.test(h)))) {
    throw new QueueError('invalid auto-approval context');
  }
  return db.transaction(() => {
    const state = loadState(db), eligible = new Map(), skipped = [];
    for (const snapshot of context.items) {
      const t = state.byId.get(snapshot.id);
      const decided = db.prepare('SELECT 1 FROM agent_review_decisions WHERE todo_id = ? AND run_id = ? AND stage_id = ?')
        .get(snapshot.id, context.run_id, context.stage_id);
      const held = db.prepare('SELECT fingerprint FROM auto_approval_holds WHERE todo_id = ?').get(snapshot.id);
      if (!t || t.status !== 'proposed' || t.auto_approval_blocked || decided
        || held?.fingerprint === snapshot.fingerprint || approvalFingerprint(db, t, state, humanNote) !== snapshot.basis) {
        skipped.push(snapshot.id);
        continue;
      }
      // No verdict is no decision: the next round examines the item again.
      // The approver cannot reject, so a stray rejection only holds the item.
      const review = reviews.find((r) => r.id === t.id);
      if (!review) { skipped.push(t.id); continue; }
      eligible.set(t.id, { item: t, fingerprint: snapshot.fingerprint,
        review: review.verdict === 'reject' ? { ...review, verdict: 'abstain' } : review });
    }
    const approvals = new Set([...eligible.values()].filter((e) => e.review.verdict === 'approve').map((e) => e.item.id));
    // Remove dependents too when a prerequisite's own approval cannot apply.
    let changed;
    do {
      changed = false;
      for (const id of approvals) {
        const missing = unapprovedPrereqs(state, id).filter((d) => !approvals.has(d));
        if (missing.length) {
          approvals.delete(id);
          eligible.get(id).review = { id, verdict: 'abstain', body: `Held: waiting prerequisites ${ids(missing)} were not approved in this result.` };
          changed = true;
        }
      }
    } while (changed);
    const approved = [], held = [], reviewed = [];
    for (const { item, fingerprint, review } of eligible.values()) {
      agentReview(db, item.id, { ...context, ...review, recordNote: false });
      reviewed.push(item.id);
      if (approvals.has(item.id)) {
        setStatus(db, item, 'approved', { priority: 0 });
        log(db, item.id, `Auto-approved in round ${context.run_id}, priority ${priorityWords({ ...item, priority: 0 })}. Reason: ${review.body.trim()}`, 'auto-approval agent');
        db.prepare('DELETE FROM auto_approval_holds WHERE todo_id = ?').run(item.id);
        approved.push(item.id);
      } else {
        log(db, item.id, `Held for human review in round ${context.run_id}. Reason: ${review.body.trim()}`, 'auto-approval agent');
        db.prepare(`INSERT INTO auto_approval_holds (todo_id, fingerprint) VALUES (?, ?)
          ON CONFLICT (todo_id) DO UPDATE SET fingerprint = excluded.fingerprint`).run(item.id, fingerprint);
        held.push(item.id);
      }
      db.prepare('INSERT INTO agent_review_decisions (todo_id, run_id, stage_id, authority, decision) VALUES (?, ?, ?, ?, ?)')
        .run(item.id, context.run_id, context.stage_id, 'approve', approvals.has(item.id) ? 'approved' : 'human review');
    }
    return { proposed: [], reviewed, approved, held, skipped };
  }).immediate();
}

export function settleAgentReviews(db, { run_id, stage_id, reviewers }) {
  if (!Array.isArray(reviewers) || !reviewers.length) return [];
  if (new Set(reviewers.map((r) => r.agent_id)).size !== reviewers.length
    || reviewers.some((r) => !r.agent_id || !['advisory', 'filter', 'approve'].includes(r.authority))) {
    throw new QueueError('invalid stage reviewer roster');
  }
  return db.transaction(() => {
    const items = db.prepare('SELECT DISTINCT todo_id FROM agent_reviews WHERE run_id = ? AND stage_id = ?').all(run_id, stage_id);
    const decisions = [];
    for (const { todo_id } of items) {
      const t = mustGet(db, todo_id);
      if (t.status !== 'proposed' || db.prepare('SELECT 1 FROM agent_review_decisions WHERE todo_id = ? AND run_id = ? AND stage_id = ?').get(todo_id, run_id, stage_id)) continue;
      const votes = db.prepare('SELECT * FROM agent_reviews WHERE todo_id = ? AND run_id = ? AND stage_id = ?').all(todo_id, run_id, stage_id);
      const rosterVotes = reviewers.map((r) => votes.find((v) => v.agent_id === r.agent_id && v.authority === r.authority));
      const rejects = rosterVotes.filter((v) => v?.authority === 'filter' && v.verdict === 'reject').length;
      const unanimous = rosterVotes.every((v) => v?.authority === 'approve' && v.verdict === 'approve');
      const authority = rejects > reviewers.length / 2 ? 'filter' : unanimous ? 'approve' : 'advisory';
      const decision = authority === 'filter' ? 'screened out' : authority === 'approve' ? 'approved' : 'human review';
      const reasons = rosterVotes.filter(Boolean).map((v) => `${v.agent_id} [${v.authority}] ${v.verdict}: ${v.body}`).join('\n');
      if (authority === 'filter') setStatus(db, t, 'archived', { status_note: `Screened out by agent filter majority.\n${reasons}` });
      if (authority === 'approve') setStatus(db, t, 'approved', { priority: t.priority });
      db.prepare('INSERT INTO agent_review_decisions (todo_id, run_id, stage_id, authority, decision) VALUES (?, ?, ?, ?, ?)')
        .run(t.id, run_id, stage_id, authority, decision);
      log(db, t.id, `Team stage ${stage_id}: ${decision} [${authority} authority; ${rosterVotes.filter(Boolean).length}/${reviewers.length} responses].\n${reasons}`, 'runner');
      decisions.push({ id: t.id, decision, authority });
    }
    return decisions;
  }).immediate();
}
