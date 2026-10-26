// Non-build agents return data. Only the runner applies their allowed effects.
import * as Q from './queue.js';

export function resultObject(raw) {
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.is_error) throw new Error('agent returned an error or no object');
  if (raw.structured_output !== undefined) return raw.structured_output;
  return raw;
}

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}

export function applyTeamResult(db, context, raw) {
  const result = resultObject(raw);
  fields(result, ['proposals', 'reviews', 'report'], 'agent result');
  for (const key of ['run_id', 'stage_id', 'role_id', 'agent_id']) {
    if (typeof context[key] !== 'string' || !context[key]) throw new Error(`missing context ${key}`);
  }
  if (!Array.isArray(context.capabilities)) throw new Error('missing capabilities');
  const proposals = result.proposals ?? [], reviews = result.reviews ?? [];
  if (!Array.isArray(proposals) || !Array.isArray(reviews) || proposals.length > 128 || reviews.length > 10000) throw new Error('invalid result arrays');
  if (proposals.length && !context.capabilities.includes('propose')) throw new Error('role lacks propose capability');
  if (reviews.length && !context.capabilities.includes('review')) throw new Error('role lacks review capability');
  if (result.report !== undefined && (typeof result.report !== 'string' || result.report.length > 200000 || !context.capabilities.includes('report'))) throw new Error('role lacks report capability or report is invalid');
  if (new Set(reviews.map((r) => r.id)).size !== reviews.length) throw new Error('duplicate review of an item in one turn');
  for (const p of proposals) {
    fields(p, ['title', 'body', 'deps', 'priority'], 'proposal');
    if (typeof p.title !== 'string' || typeof p.body !== 'string' || p.body.length > 100000) throw new Error('proposal needs title and body');
  }
  for (const r of reviews) {
    fields(r, ['id', 'verdict', 'body'], 'review');
    if (!Number.isSafeInteger(r.id) || r.id < 1) throw new Error('invalid review item id');
    if (!['approve', 'reject', 'abstain'].includes(r.verdict) || typeof r.body !== 'string' || !r.body.trim() || r.body.length > 24000) throw new Error('invalid review verdict or reason');
  }
  for (const key of ['per_round', 'max_waiting']) {
    if (!Number.isSafeInteger(context[key]) || context[key] < 0) throw new Error(`invalid context ${key}`);
  }
  if (context.auto_approval) return Q.applyAutoApprovals(db, context, reviews);
  return db.transaction(() => {
    const proposed = [], reviewed = [];
    let used = db.prepare('SELECT COUNT(*) AS n FROM team_proposals WHERE run_id = ?').get(context.run_id).n;
    let waiting = db.prepare("SELECT COUNT(*) AS n FROM todos WHERE status = 'proposed'").get().n;
    for (const p of proposals) {
      if (used >= context.per_round || waiting >= context.max_waiting) break;
      const id = Q.addItem(db, { title: p.title, body: p.body, deps: p.deps || [], suggestedPriority: p.priority,
        source: `${context.stage_id}/${context.agent_id}`, author: `${context.stage_id}/${context.agent_id}`, runId: context.run_id });
      db.prepare('INSERT INTO team_proposals (run_id, todo_id) VALUES (?, ?)').run(context.run_id, id);
      proposed.push(id); used++; waiting++;
    }
    for (const r of reviews) {
      if (Q.agentReview(db, r.id, { ...context, ...r })) reviewed.push(r.id);
    }
    if (context.capabilities.includes('review')) {
      const previous = db.prepare('SELECT todo_id FROM agent_reviews WHERE run_id = ? AND stage_id = ? AND agent_id = ?')
        .all(context.run_id, context.stage_id, context.agent_id);
      for (const { todo_id } of previous) {
        if (!reviews.some((r) => r.id === todo_id)) Q.agentReview(db, todo_id, { ...context, verdict: 'abstain', body: 'No verdict returned in the latest discussion turn.' });
      }
    }
    return { proposed, reviewed, ...(result.report !== undefined ? { report: result.report } : {}) };
  }).immediate();
}
