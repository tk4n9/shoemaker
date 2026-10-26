#!/usr/bin/env node
// Scaffold a new page feature.  Usage:  node scripts/new-page.mjs <name> [Label]
//
// Creates src/features/<name>.js wired to GET /<name> with a nav entry.
// The registry auto-discovers it — no other file needs editing.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEATURES = join(__dirname, '..', 'src', 'features');

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: node scripts/new-page.mjs <name> [Label]');
  process.exit(1);
}
const name = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
if (!name) {
  console.error(`Invalid name: "${raw}". Use letters, numbers, hyphens.`);
  process.exit(1);
}
const label = process.argv[3] || (name[0].toUpperCase() + name.slice(1));
const file = join(FEATURES, `${name}.js`);

if (existsSync(file)) {
  console.error(`Refusing to overwrite existing feature: src/features/${name}.js`);
  process.exit(1);
}

const template = `// ${label} page. Auto-discovered by the feature registry.
// Docs: docs/adding-a-feature.md   |   API: the ctx object in src/core/context.js
import { esc } from '../core/layout.js';

function view() {
  return \`
    <h1>${label}</h1>
    <p>Edit <code>src/features/${name}.js</code> to build this page.</p>\`;
}

export default {
  id: '${name}',
  order: 50,                                   // nav/dispatch order (lower = earlier)
  nav: { label: '${label}', href: '/${name}' },  // remove to hide from nav
  routes: [
    { method: 'GET', path: '/${name}', handler: (ctx) => {
      ctx.page({ title: '${label}', body: view() });
    } },
    // Add more routes here, e.g.:
    // { method: 'POST', path: '/${name}/save', handler: async (ctx) => {
    //     const body = await ctx.body();
    //     // ctx.db.prepare(...).run(...);
    //     ctx.json(200, { ok: true });
    // } },
  ],
};
`;

mkdirSync(FEATURES, { recursive: true });
writeFileSync(file, template);
console.log(`Created src/features/${name}.js  →  GET /${name}`);
console.log('Next: run `npm run check`, then start the server and open the new page.');
