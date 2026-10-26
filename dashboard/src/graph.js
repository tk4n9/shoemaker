// Dependency graph for the Todos page: a layered layout (prerequisites on the
// left, the items that need them to their right) drawn as one server-side SVG.
// No library and no client script; each node links to its detail page.
import { esc, u } from './core/layout.js';

export const NODE = { w: 212, h: 60 };
const GAP_X = 56;
const GAP_Y = 14;
const PAD = 8;
const CHARS = 28;   // characters per title line at 13px in a node

// nodes: [{ id, ... }] in their preferred top-to-bottom order;
// edges: [[prerequisiteId, dependentId], ...] between those nodes.
// Returns each node's top-left corner and the drawing's size.
export function layout(nodes, edges) {
  const deps = new Map(nodes.map((n) => [n.id, []]));
  const dependents = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    if (deps.has(a) && deps.has(b)) { deps.get(b).push(a); dependents.get(a).push(b); }
  }

  // Column = length of the longest prerequisite chain below the node.
  const col = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (col.has(id)) return col.get(id);
    if (visiting.has(id)) return 0;   // a loop: the queue refuses them, but never hang on one
    visiting.add(id);
    const d = deps.get(id).length ? 1 + Math.max(...deps.get(id).map(depth)) : 0;
    visiting.delete(id);
    col.set(id, d);
    return d;
  };
  const cols = [];
  for (const n of nodes) (cols[depth(n.id)] ??= []).push(n.id);
  for (let c = 0; c < cols.length; c++) cols[c] ??= [];
  const rows = Math.max(...cols.map((c) => c.length));

  // Order each column by the average height of its neighbours, a few sweeps
  // each way, so the arrows cross less. Columns are centred vertically.
  const y = new Map();
  const place = () => cols.forEach((c) => c.forEach((id, i) => y.set(id, (rows - c.length) / 2 + i)));
  place();
  const mean = (list, own) => (list.length ? list.reduce((s, id) => s + y.get(id), 0) / list.length : own);
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < cols.length; c++) {
      cols[c].sort((a, b) => mean(deps.get(a), y.get(a)) - mean(deps.get(b), y.get(b)));
      place();
    }
    for (let c = cols.length - 2; c >= 0; c--) {
      cols[c].sort((a, b) => mean(dependents.get(a), y.get(a)) - mean(dependents.get(b), y.get(b)));
      place();
    }
  }

  const pos = new Map();
  for (const [id, row] of y) {
    pos.set(id, { x: PAD + col.get(id) * (NODE.w + GAP_X), y: PAD + row * (NODE.h + GAP_Y) });
  }
  return {
    pos,
    columns: cols.length,
    width: PAD * 2 + cols.length * NODE.w + (cols.length - 1) * GAP_X,
    height: PAD * 2 + rows * NODE.h + (rows - 1) * GAP_Y,
  };
}

// Up to two lines of at most `n` characters, word-wrapped, with an ellipsis
// when the title does not fit (the node's tooltip has all of it).
export function wrapTitle(text, n = CHARS) {
  const lines = [];
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= n) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const cut = (s) => `${s.slice(0, n - 1)}…`;
  const fit = (s) => (s.length > n ? cut(s) : s);
  if (lines.length <= 2) return lines.map(fit);
  // More follows: end the second line at a word, with room for the ellipsis.
  const words = lines[1].split(' ');
  while (words.length > 1 && `${words.join(' ')}…`.length > n) words.pop();
  const second = `${words.join(' ')}…`;
  return [fit(lines[0]), second.length > n ? cut(second) : second];
}

// nodes: [{ id, title, meta, cls, label }]; edges: [[from, to, met]] where
// `met` means the prerequisite has shipped.
export function renderGraph(nodes, edges) {
  if (!nodes.length) return '';
  const { pos, width, height } = layout(nodes, edges);
  const { w, h } = NODE;
  const arrows = edges.map(([a, b, met]) => {
    const p = pos.get(a);
    const q = pos.get(b);
    const x1 = p.x + w;
    const y1 = p.y + h / 2;
    const x2 = q.x - 1;
    const y2 = q.y + h / 2;
    const bend = Math.max(20, (x2 - x1) / 2);
    return `<path class="g-edge${met ? ' met' : ''}" d="M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}" marker-end="url(#g-head${met ? '-met' : ''})"/>`;
  }).join('');
  const boxes = nodes.map((n) => {
    const { x, y } = pos.get(n.id);
    const [l1 = '', l2 = ''] = wrapTitle(n.title);
    return `<a href="${esc(u(`/todos/${n.id}`))}" class="g-node ${esc(n.cls)}" aria-label="${esc(n.label)}">`
      + `<title>${esc(n.label)}</title>`
      + `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`
      + `<text x="${x + 9}" y="${y + 17}" class="g-meta">${esc(n.meta)}</text>`
      + `<text x="${x + 9}" y="${y + 35}" class="g-title">${esc(l1)}</text>`
      + (l2 ? `<text x="${x + 9}" y="${y + 51}" class="g-title">${esc(l2)}</text>` : '')
      + '</a>';
  }).join('');
  const head = (id, cls) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="${cls}"/></marker>`;
  return `<svg class="graph-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Dependency graph">`
    + `<defs>${head('g-head', 'g-head')}${head('g-head-met', 'g-head met')}</defs>${arrows}${boxes}</svg>`;
}
