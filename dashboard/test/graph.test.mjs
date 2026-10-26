// The dependency graph's layout and drawing (src/graph.js). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, wrapTitle, renderGraph, NODE } from '../src/graph.js';

const n = (id, title = `Item ${id}`) => ({ id, title, meta: `#${id}`, cls: 'st-proposed', label: `#${id} ${title}` });

test('a prerequisite sits in a column left of everything that needs it', () => {
  // A, B → C → D, and E → D directly.
  const nodes = [1, 2, 3, 4, 5].map((id) => n(id));
  const edges = [[1, 3], [2, 3], [3, 4], [5, 4]];
  const { pos, columns, width, height } = layout(nodes, edges);
  const col = (id) => Math.round((pos.get(id).x - 8) / (NODE.w + 56));
  assert.deepEqual([1, 2, 3, 4, 5].map(col), [0, 0, 1, 2, 0]);
  assert.equal(columns, 3);
  assert.ok(width >= 3 * NODE.w && height >= 3 * NODE.h);
  // No two nodes overlap.
  const boxes = [...pos.values()].map((p) => `${p.x},${p.y}`);
  assert.equal(new Set(boxes).size, boxes.length);
});

test('a loop does not hang the layout', () => {
  const { pos } = layout([n(1), n(2)], [[1, 2], [2, 1]]);
  assert.equal(pos.size, 2);
});

test('titles wrap to two lines and end with an ellipsis when cut', () => {
  assert.deepEqual(wrapTitle('Short title'), ['Short title']);
  assert.deepEqual(wrapTitle('Pin the save bar to the bottom of the window on long rule lists', 28),
    ['Pin the save bar to the', 'bottom of the window on…']);
  const [first] = wrapTitle('a'.repeat(40), 28);
  assert.equal(first.length, 28);
  assert.ok(first.endsWith('…'));
});

test('one link per node, one arrow per edge, everything escaped', () => {
  const svg = renderGraph([n(1, 'Base <b>bold</b>'), n(2, 'Top & co')], [[1, 2, true]]);
  assert.equal((svg.match(/<a href="\/todos\/\d+"/g) || []).length, 2);
  assert.equal((svg.match(/<path class="g-edge met"/g) || []).length, 1);
  assert.match(svg, /marker-end="url\(#g-head-met\)"/);
  assert.match(svg, /Base &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(svg, /Top &amp; co/);
  assert.doesNotMatch(svg, /<b>/);
  assert.equal(renderGraph([], []), '');
});
