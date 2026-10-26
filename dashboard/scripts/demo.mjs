#!/usr/bin/env node
// demo.mjs — fill a fresh queue with a made-up project's history, for screenshots,
// UI work and trying the dashboard out. Everything in it is fictional.
//
//   SHOEMAKER_STATE=<empty or new dir> node scripts/demo.mjs
//
// It writes queue.db (and dashboard.json, without a password, if there is none)
// in that directory, and refuses a queue that already has items.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.SHOEMAKER_STATE;
if (!STATE) {
  console.error('demo: set SHOEMAKER_STATE to an empty directory');
  process.exit(2);
}
mkdirSync(STATE, { recursive: true });
const conf = join(STATE, 'dashboard.json');
if (!existsSync(conf)) {
  writeFileSync(conf, JSON.stringify({ project: 'Inkwell', host: '127.0.0.1', port: 6599, password: '', base_path: '' }, null, 2) + '\n');
}

const { db, initSchema } = await import('../src/db.js');
const Q = await import('../src/queue.js');
initSchema();
if (db.prepare('SELECT COUNT(*) AS n FROM todos').get().n) {
  console.error('demo: this queue already has items; use an empty state directory');
  process.exit(1);
}

const SUGGEST = 'suggestion agent';
const BUILD = 'implementation agent';
const PR = (n) => `https://github.com/inkwell-notes/inkwell/pull/${n}`;
const spec = ({ problem, change, files, tests = 'Unit tests for the new behaviour.', size = 'about 80 lines; low risk.', priority = 'normal' }) =>
  `**Problem:** ${problem}\n\n**Change:** ${change}\n\n**Files:** ${files.map((f) => `\`${f}\``).join(', ')}\n\n`
  + `**Tests:** ${tests}\n\n**Docs:** none\n\n**Builds on:** nothing\n\n**Size and risks:** ${size}\n\n**Priority:** ${priority}.`;

// Each entry: [title, spec, final status, {deps, priority, source, days ago, pr}]
const items = [
  ['Search finds notes by words in their body, not only titles', spec({
    problem: 'The search box matches titles only (`src/search/index.ts:41`); 3 of 5 lookups in the usage notes were for words inside a note.',
    change: 'Typing in search matches note bodies too, with the matching line shown under each result.',
    files: ['src/search/index.ts', 'src/search/Results.tsx'], priority: 'high' }), 'shipped', { pr: 412, ago: 6 }],
  ['Pressing Escape closes the note editor without losing a draft', spec({
    problem: 'Escape does nothing in the editor (`src/editor/Editor.tsx:118`); the only way out is the close button, which discards unsaved text.',
    change: 'Escape closes the editor and keeps the draft, which reopens with the note.',
    files: ['src/editor/Editor.tsx', 'src/editor/drafts.ts'] }), 'shipped', { pr: 415, ago: 5 }],
  ['Show when a note was last edited, in the list', spec({
    problem: 'The note list shows titles only; sorting by "recent" gives no hint of how recent.',
    change: 'Each row shows "edited 2 h ago" in muted text.',
    files: ['src/notes/NoteRow.tsx'], priority: 'low' }), 'shipped', { pr: 417, ago: 4 }],
  ['Tags: add and remove tags on a note', spec({
    problem: 'Notes can only be grouped by folder (`src/notes/model.ts:12` has no tags field).',
    change: 'A tag field under the title; tags show as chips in the list.',
    files: ['src/notes/model.ts', 'src/notes/TagField.tsx', 'src/db/migrations/007_tags.sql'], size: 'about 260 lines; a schema migration.' }), 'shipped', { pr: 421, ago: 3 }],
  ['Tags: filter the note list by a tag', spec({
    problem: 'With tags in place, there is still no way to see only the notes with one tag.',
    change: 'Clicking a tag chip filters the list; a "×" clears the filter.',
    files: ['src/notes/NoteList.tsx', 'src/notes/filters.ts'] }), 'review', { deps: [4], pr: 426, ago: 1 }],
  ['Tags: rename a tag everywhere at once', spec({
    problem: 'A misspelt tag must be fixed note by note.',
    change: 'Settings › Tags lists every tag with a rename action.',
    files: ['src/settings/Tags.tsx', 'src/notes/model.ts'] }), 'approved', { deps: [4, 5], priority: 2, ago: 1 }],
  ['Export a note as Markdown', spec({
    problem: 'There is no way to get a note out of Inkwell except copy and paste.',
    change: 'The note menu has "Export as Markdown", which downloads `<title>.md`.',
    files: ['src/notes/NoteMenu.tsx', 'src/export/markdown.ts'] }), 'in_progress', { priority: 1, ago: 0 }],
  ['Keep the editor toolbar visible while scrolling a long note', spec({
    problem: 'The toolbar scrolls away (`src/editor/Toolbar.css:3` is static); in notes over a screen long, formatting needs a scroll back up.',
    change: 'The toolbar sticks to the top of the editor.',
    files: ['src/editor/Toolbar.css'], priority: 'low' }), 'approved', { priority: 0, ago: 0 }],
  ['Sync status: say when the last sync failed, and why', spec({
    problem: 'A failed sync is only logged to the console (`src/sync/client.ts:88`); the header keeps showing a green dot.',
    change: 'The header shows "Not synced: offline since 14:02" and a Retry button.',
    files: ['src/sync/client.ts', 'src/app/Header.tsx'], priority: 'high', size: 'about 150 lines; touches the sync client, read-only outside error handling.' }), 'failed',
    { priority: 1, ago: 1, note: 'RULES.md puts src/sync/ off limits; the error-surface part needs a human-authorized exception for src/sync/client.ts.' }],
  ['Undo for deleting a note', spec({
    problem: 'Delete is immediate and final (`src/notes/actions.ts:54`).',
    change: 'Deleting shows "Note deleted · Undo" for 10 seconds.',
    files: ['src/notes/actions.ts', 'src/app/Toast.tsx'] }), 'proposed', { ago: 0 }],
  ['Count words and reading time in the note footer', spec({
    problem: 'Writers asked for a word count; nothing in the editor reports length.',
    change: 'The footer shows "412 words · 2 min read", updated as you type.',
    files: ['src/editor/Footer.tsx'], priority: 'low' }), 'proposed', { ago: 0 }],
  ['Open the most recent note on start, instead of an empty screen', spec({
    problem: 'The app opens on an empty pane (`src/app/App.tsx:30`); every session starts with a click.',
    change: 'Start opens the note you edited last.',
    files: ['src/app/App.tsx', 'src/app/session.ts'] }), 'proposed', { ago: 0 }],
  ['Paste an image straight into a note', '', 'proposed', { source: 'you', ago: 0 }],
  ['Rewrite the editor in a new framework', spec({
    problem: 'The editor component is large.',
    change: 'A rewrite.',
    files: ['src/editor/'], size: 'thousands of lines.' }), 'archived', { ago: 4, note: 'Far too big for one round, and not the focus.' }],
];

const daysAgo = (d, h = 0) => new Date(Date.now() - d * 86400e3 - h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const run = (d) => daysAgo(d).slice(0, 16).replace(/[ :]/g, '-').replace(/-(\d\d)-(\d\d)$/, '-$1$2');
const ids = [];
for (const [title, body, status, o] of items) {
  const source = o.source ?? SUGGEST;
  const id = Q.addItem(db, {
    title, body, deps: (o.deps ?? []).map((i) => ids[i - 1]), source, author: source,
    runId: source === 'you' ? null : run(o.ago + 1), suggestedPriority: body.match(/\*\*Priority:\*\* (\w+)/)?.[1] ?? null,
  });
  ids.push(id);
  if (status === 'proposed') continue;
  if (status === 'archived') { Q.archive(db, id, o.note); continue; }
  Q.approve(db, id, o.priority ?? 0);
  if (status === 'approved') continue;
  Q.claim(db, id, run(o.ago), BUILD);
  const branch = `shoemaker/q${id}-${title.toLowerCase().replace(/[^a-z]+/g, '-').split('-').slice(0, 3).join('-')}`;
  Q.setLinks(db, id, { branch }, BUILD);
  if (status === 'in_progress') { Q.log(db, id, 'Plan written; implementing the Markdown serializer.', BUILD); continue; }
  if (status === 'failed') { Q.fail(db, id, o.note, BUILD); continue; }
  Q.setLinks(db, id, { pr: PR(o.pr) }, BUILD);
  if (status === 'review') { Q.toReview(db, id, PR(o.pr), BUILD); continue; }
  Q.ship(db, id, { pr: PR(o.pr) }, BUILD);
}

// Spread the history over the past week, as the rounds would have left it.
for (const [i, [, , status, o]] of items.entries()) {
  const id = ids[i];
  db.prepare('UPDATE todos SET created_at = ?, approved_at = CASE WHEN approved_at IS NULL THEN NULL ELSE ? END, shipped_at = CASE WHEN shipped_at IS NULL THEN NULL ELSE ? END, updated_at = ? WHERE id = ?')
    .run(daysAgo(o.ago + 1, 3), daysAgo(o.ago + 1, 1), daysAgo(o.ago, 2), daysAgo(o.ago, 2), id);
  db.prepare('UPDATE comments SET created_at = ? WHERE todo_id = ?').run(daysAgo(o.ago, status === 'shipped' ? 2 : 1), id);
}
db.prepare("UPDATE config SET project_name = 'Inkwell' WHERE id = 1").run();
console.log(`demo: ${ids.length} items in ${join(STATE, 'queue.db')}`);
