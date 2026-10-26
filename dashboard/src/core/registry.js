// Feature registry. Auto-discovers every module in src/features/. Drop a new
// file there and it is loaded automatically — no central list to edit.
//
// A feature module's default export:
//   {
//     id:    'pdf',                       // unique id
//     order: 20,                          // nav/dispatch sort (default 100)
//     nav:   { label: 'Paper', href: '/pdf' },   // optional nav entry
//     init:  (db) => {...},               // optional one-time schema/setup
//     routes: [ { method, path, handler, public? } ],
//   }
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FEATURES_DIR = join(here, '..', 'features');

export async function loadFeatures(db) {
  const files = readdirSync(FEATURES_DIR).filter((f) => f.endsWith('.js'));
  const features = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(FEATURES_DIR, file)).href);
    const feat = mod.default;
    if (!feat || !Array.isArray(feat.routes)) {
      console.warn(`Skipping ${file}: default export missing a routes array.`);
      continue;
    }
    feat._file = file;
    if (typeof feat.init === 'function') feat.init(db);
    features.push(feat);
  }
  features.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  return features;
}

export const collectRoutes = (features) => features.flatMap((f) => f.routes);
export const navItems = (features) => features.filter((f) => f.nav).map((f) => f.nav);
