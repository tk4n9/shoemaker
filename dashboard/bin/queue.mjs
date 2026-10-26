#!/usr/bin/env node
// queue — the agents' side of the Shoemaker queue (the repository's docs/queue.md).
// It opens the same SQLite file as the web server ($SHOEMAKER_STATE/queue.db, or
// $SHOEMAKER_DB), so it works whether or not the server is running.
//
//   queue list [--status a,b] [--json]       every item, or only those statuses
//   queue show <id> [--json]                 one item with its spec and log
//   queue stats [--json]                     counts per status, and how many are ready
//   queue approval [--json]                  read auto-approval mode and eligible snapshot
//   queue next [--max N] [--json]            what the implementation agent takes next (exit 3: nothing)
//   queue pick --run RUN [--max N] [--json]  next + claim in one step (exit 3: nothing)
//                                            --max N: up to N items to build side by side, never
//                                            two whose specs' Files lines name the same file
//   queue add --title T [--body-file F|-] [--body TEXT] [--deps 3,5] [--priority high|normal|low] [--run RUN]
//   queue note <id> TEXT
//   queue claim <id> --run RUN
//   queue set <id> [--branch B] [--pr URL]
//   queue review <id> [--pr URL]             a draft pull request waits for the human's merge
//   queue ship <id> [--pr URL] [--note TEXT]
//   queue fail <id> --note TEXT
//   queue release <id> --note TEXT          give back an attempt the agent never used (runner)
//   queue merged <id> [--pr URL] [--note T]  the item's pull request has merged (runner)
//
// --mr URL is accepted as another name for --pr URL.
// Log entries name their writer from --by or $SHOEMAKER_AUTHOR (default "agent").
// Approving, prioritising and rejecting belong to the human, on the web page;
// this tool has no command for them. `add --priority` is only a recommendation:
// it applies while the human leaves the item's priority on Auto.
import { readFileSync } from 'node:fs';
import { db, initSchema } from '../src/db.js';
import * as Q from '../src/queue.js';
import { teamContext } from '../src/team-context.js';

const VALUE_FLAGS = ['status', 'title', 'body', 'body-file', 'deps', 'priority', 'run', 'branch', 'pr', 'mr', 'note', 'by', 'max', 'exclude'];
const BOOL_FLAGS = ['json'];

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (!VALUE_FLAGS.includes(key)) {
      // An unknown flag is refused, not ignored: a mistyped --deps must not drop the prerequisites.
      if (!BOOL_FLAGS.includes(key)) usage(`unknown option --${key}`);
      opt[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) usage(`--${key} needs a value`);
    opt[key] = value;
  }
  if (opt.pr === undefined && opt.mr !== undefined) opt.pr = opt.mr;   // --mr: the GitLab name
  return { pos, opt };
}

function usage(msg) {
  if (msg) console.error(`queue: ${msg}`);
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const header = lines.slice(0, lines.findIndex((l) => !l.startsWith('//')));
  console.error(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(2);
}

const needId = (pos) => {
  const id = Number(String(pos[1] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) usage(`${pos[0]} needs an item number`);
  return id;
};

// ---------- Output ----------
function statusWords(t) {
  switch (t.status) {
    case 'proposed': return 'waiting for review';
    case 'approved': return `approved, ${Q.priorityWords(t)}${t.effective_priority < t.base_priority ? ` (treated as ${Q.PRIORITY_LABEL[t.effective_priority]})` : ''}, ${t.ready ? 'ready' : 'waiting'}`;
    case 'in_progress': return `in progress (attempt ${t.attempts} of ${Q.MAX_ATTEMPTS})`;
    case 'review': return "waiting for the human's merge";
    case 'failed': return `failed: ${t.status_note || 'no reason given'}`;
    case 'archived': return `archived (rejected${t.status_note ? `: ${t.status_note}` : ''})`;
    default: return t.status;
  }
}

const depWords = (state, list) => list.map((d) => `#${d} (${statusWords(state.byId.get(d)).split(/[,(:]/)[0].trim()})`).join(', ');

function line(state, t) {
  return `#${t.id} ${statusWords(t)} — ${t.title}${t.deps.length ? ` — needs ${depWords(state, t.deps)}` : ''}`;
}

function toJSON(state, t, full = false) {
  const out = {
    id: t.id, title: t.title, status: t.status,
    priority: t.priority, priority_label: Q.priorityWords(t), suggested_priority: t.suggested_priority,
    effective_priority: t.effective_priority,
    ready: t.ready, deps: t.deps, blockers: t.blockers, dependents: t.dependents,
    source: t.source, run_id: t.run_id, last_run: t.last_run, branch: t.branch, pr_url: t.pr_url,
    attempts: t.attempts, status_note: t.status_note,
    created_at: t.created_at, approved_at: t.approved_at, shipped_at: t.shipped_at, archived_at: t.archived_at,
    updated_at: t.updated_at,
  };
  if (full) {
    out.spec = t.explanation;
    out.log = Q.itemLog(db, t.id).map((c) => ({ at: c.created_at, by: c.author, text: c.body }));
  }
  return out;
}

function showText(state, t) {
  const rows = [
    `#${t.id} ${t.title}`,
    `status: ${statusWords(t)}`,
    `from: ${t.source}${t.run_id ? `, run ${t.run_id}` : ''}, ${t.created_at} UTC`,
    ...(t.suggested_priority ? [`suggested priority: ${Q.PRIORITY_LABEL[t.suggested_priority]}`] : []),
    `needs: ${t.deps.length ? depWords(state, t.deps) : 'nothing'}`,
    `needed by: ${t.dependents.length ? depWords(state, t.dependents) : 'nothing'}`,
  ];
  if (t.branch) rows.push(`branch: ${t.branch}`);
  if (t.pr_url) rows.push(`pull request: ${t.pr_url}`);
  if (t.attempts) rows.push(`attempts: ${t.attempts} of ${Q.MAX_ATTEMPTS}${t.last_run ? `, last in run ${t.last_run}` : ''}`);
  rows.push('', '--- spec ---', t.explanation.trim() || '(empty: work from the title)', '', '--- log ---');
  for (const c of Q.itemLog(db, t.id)) rows.push(`${c.created_at} UTC  ${c.author}: ${c.body}`);
  return rows.join('\n');
}

function print(out, json, text) {
  console.log(json ? JSON.stringify(out, null, 2) : text());
}

// ---------- Commands ----------
function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const author = opt.by || process.env.SHOEMAKER_AUTHOR || 'agent';
  const json = Boolean(opt.json);
  const context = teamContext();
  if (context && !['list', 'show', 'stats', 'approval', 'next', 'help', undefined].includes(cmd)) {
    if (!context.capabilities?.includes('build') || !['note', 'set', 'review', 'ship', 'fail'].includes(cmd)
      || needId(pos) !== context.item_id) throw new Q.QueueError('team capability refuses this queue action or item');
  }
  initSchema();

  switch (cmd) {
    case 'approval': {
      if (pos.length !== 1 || Object.keys(opt).some((key) => key !== 'json')) usage('approval is read-only and takes only --json');
      const snapshot = Q.approvalSnapshot(db);
      return print(snapshot, json, () => `auto approval: ${snapshot.enabled ? 'on' : 'off'}; ${snapshot.items.length} ideas to examine`);
    }
    case 'list': {
      const state = Q.loadState(db);
      const want = opt.status ? String(opt.status).split(',').map((s) => s.trim()) : null;
      for (const s of want || []) if (!Q.STATUSES.includes(s)) usage(`unknown status "${s}" (one of ${Q.STATUSES.join(', ')})`);
      const items = state.items.filter((t) => !want || want.includes(t.status));
      return print(items.map((t) => toJSON(state, t)), json,
        () => (items.length ? items.map((t) => line(state, t)).join('\n') : '(no items)'));
    }
    case 'show': {
      const state = Q.loadState(db);
      const t = state.byId.get(needId(pos));
      if (!t) throw new Q.QueueError(`no item #${pos[1]}`);
      return print(toJSON(state, t, true), json, () => showText(state, t));
    }
    case 'stats': {
      const s = Q.stats(db);
      return print(s, json, () => Object.entries(s).map(([k, v]) => `${k}: ${v}`).join('\n'));
    }
    case 'next':
    case 'pick': {
      if (cmd === 'pick' && !opt.run) usage('pick needs --run RUN');
      if (opt.max !== undefined) {
        const max = Number(opt.max);
        if (!Number.isInteger(max) || max < 1) usage('--max needs a whole number of at least 1');
        const exclude = Q.parseIds(opt.exclude);
        const m = cmd === 'pick' ? Q.pickMany(db, opt.run, max, author, { exclude }) : Q.nextItems(db, max, { exclude });
        const state = Q.loadState(db);
        const items = m.items.map((c) => ({ item: toJSON(state, state.byId.get(c.item.id), true), resume: c.resume }));
        print({ items, why: m.why }, json, () => (items.length
          ? items.map((c) => `${c.resume ? 'resume' : 'new'}: ${line(state, state.byId.get(c.item.id))}`).join('\n')
          : `nothing to build: ${m.why}`));
        return items.length ? 0 : 3;
      }
      const n = cmd === 'pick' ? Q.pick(db, opt.run, author) : Q.nextItem(db);
      const state = Q.loadState(db);
      if (!n.item) {
        print({ item: null, why: n.why }, json, () => `nothing to build: ${n.why}`);
        return 3;
      }
      const t = state.byId.get(n.item.id);
      return print({ item: toJSON(state, t, true), resume: n.resume }, json,
        () => `${n.resume ? 'resume' : 'new'}: ${showText(state, t)}`);
    }
    case 'add': {
      let body = opt.body ?? '';
      if (opt['body-file']) {
        try {
          body = readFileSync(opt['body-file'] === '-' ? 0 : opt['body-file'], 'utf8');
        } catch (e) {
          throw new Q.QueueError(`cannot read ${opt['body-file']}: ${e.code || e.message}`);
        }
      }
      const id = Q.addItem(db, {
        title: opt.title, body, deps: opt.deps ?? '', source: author, runId: opt.run ?? null, author, suggestedPriority: opt.priority ?? null,
      });
      return print({ id }, json, () => `added #${id}`);
    }
    case 'note': {
      const id = needId(pos);
      const text = pos.slice(2).join(' ').trim();
      if (!text) usage('note needs a text');
      if (!Q.getItem(db, id)) throw new Q.QueueError(`no item #${id}`);
      Q.log(db, id, text, author);
      return print({ ok: true }, json, () => `noted on #${id}`);
    }
    case 'claim': {
      if (!opt.run) usage('claim needs --run RUN');
      const t = Q.claim(db, needId(pos), opt.run, author);
      return print({ ok: true, attempts: t.attempts }, json, () => `#${t.id} is in progress (attempt ${t.attempts} of ${Q.MAX_ATTEMPTS})`);
    }
    case 'set': {
      const id = needId(pos);
      if (!opt.branch && !opt.pr) usage('set needs --branch and/or --pr');
      Q.setLinks(db, id, { branch: opt.branch, pr: opt.pr }, author);
      return print({ ok: true }, json, () => `#${id} updated`);
    }
    case 'review': {
      const id = needId(pos);
      Q.toReview(db, id, opt.pr, author);
      return print({ ok: true }, json, () => `#${id} waits for the human's merge`);
    }
    case 'ship': {
      const id = needId(pos);
      Q.ship(db, id, { pr: opt.pr, note: opt.note }, author);
      return print({ ok: true }, json, () => `#${id} shipped`);
    }
    case 'fail': {
      const id = needId(pos);
      Q.fail(db, id, opt.note, author);
      return print({ ok: true }, json, () => `#${id} failed`);
    }
    case 'release': {
      const id = needId(pos);
      Q.release(db, id, opt.note, author);
      return print({ ok: true, status: Q.getItem(db, id).status }, json, () => `#${id} attempt given back; now ${Q.getItem(db, id).status}`);
    }
    case 'merged': {
      const id = needId(pos);
      Q.merged(db, id, { pr: opt.pr, note: opt.note }, author);
      return print({ ok: true }, json, () => `#${id} shipped (merged)`);
    }
    case undefined:
    case 'help':
      return usage();
    default:
      return usage(`unknown command "${cmd}"`);
  }
}

try {
  process.exitCode = main() ?? 0;
} catch (e) {
  if (!(e instanceof Q.QueueError)) throw e;
  console.error(`queue: ${e.message}`);
  process.exitCode = 1;
}
