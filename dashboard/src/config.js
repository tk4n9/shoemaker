// Runtime config: dashboard.json in the project's Shoemaker state directory
// (written by `shoemaker init`, mode 0600, never committed).
//   SHOEMAKER_STATE=<dir>        reads <dir>/dashboard.json (the DB is <dir>/queue.db, see db.js)
//   SHOEMAKER_DASHBOARD_CONFIG   overrides the file itself (tests)
// With neither, a development checkout reads dashboard/config.json.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE = process.env.SHOEMAKER_STATE;
const CONFIG_PATH = process.env.SHOEMAKER_DASHBOARD_CONFIG
  || (STATE ? join(STATE, 'dashboard.json') : join(ROOT, 'config.json'));

const defaults = {
  host: '127.0.0.1',  // local only; '0.0.0.0' serves the LAN (set a password)
  port: 6531,
  password: '',       // empty = auth disabled (warn)
  secret: 'dev-insecure-secret-change-me',
  base_path: '',      // e.g. '/shoemaker' when served under a subpath
  project: '',        // names the project while the queue still has the default name
  target_dir: '',     // optional: the managed repository, shown on the Dashboard
};

let fileConfig = {};
if (existsSync(CONFIG_PATH)) {
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse ${CONFIG_PATH}:`, e.message);
  }
}

export const config = { ...defaults, ...fileConfig };

// Normalize base_path to '' or '/prefix' (leading slash, no trailing slash).
let bp = String(config.base_path || '').trim();
if (bp && !bp.startsWith('/')) bp = `/${bp}`;
config.base_path = bp.replace(/\/+$/, '');

export { ROOT, CONFIG_PATH };
