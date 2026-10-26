// Thin HTTP server. Loads features from the registry and dispatches requests.
// App logic lives in src/features/*; generic plumbing lives in src/core/*.
import http from 'node:http';
import { join } from 'node:path';
import { config, ROOT, CONFIG_PATH } from './config.js';
import { db, initSchema } from './db.js';
import { isAuthed, authEnabled } from './core/auth.js';
import { serveStatic, send, json } from './core/http.js';
import { loadFeatures, collectRoutes, navItems } from './core/registry.js';
import { matchRoute } from './core/router.js';
import { makeContext } from './core/context.js';

const PUBLIC = join(ROOT, 'public');
const BASE = config.base_path;          // '' or '/prefix'

function sameSiteJson(req) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export async function createServer() {
  initSchema();
  // dashboard.json's `project` names a new queue; a name changed on the page stays.
  if (config.project) {
    db.prepare("UPDATE config SET project_name = ? WHERE id = 1 AND project_name = 'My Project'").run(String(config.project));
  }
  const features = await loadFeatures(db);
  const routes = collectRoutes(features);
  const nav = navItems(features);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let path = url.pathname;
      if (BASE) {
        if (path === BASE || path === `${BASE}/`) path = '/';
        else if (path.startsWith(`${BASE}/`)) path = path.slice(BASE.length);
        else return send(res, 404, 'Not found');
      }

      if (path.startsWith('/static/')) {
        return serveStatic(res, PUBLIC, path.replace(/^\/static\//, ''));
      }

      const match = matchRoute(routes, req.method, path);
      if (!match) return send(res, 404, 'Not found');

      if (!match.route.public && !isAuthed(req)) {
        if (req.method === 'GET') {
          res.writeHead(302, { Location: `${BASE}/login` });
          return res.end();
        }
        return json(res, 401, { error: 'unauthorized' });
      }

      // Changes come only from this app's own page: JSON bodies (a plain form
      // from another site cannot send them) and, when the browser says, the
      // same origin. Approving here lets an agent build the item.
      if (req.method !== 'GET' && !match.route.public && !sameSiteJson(req)) {
        return json(res, 403, { error: 'refused: changes must come from the dashboard page itself' });
      }

      const ctx = makeContext({ req, res, url, params: match.params, db, runtime: config, navItems: nav });
      await match.route.handler(ctx);
    } catch (err) {
      console.error('Request error:', err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });
}

// Start when run directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = await createServer();
  server.listen(config.port, config.host, () => {
    if (!authEnabled()) {
      console.warn(`⚠  No password set — auth is DISABLED. Set "password" in ${CONFIG_PATH}.`);
    }
    console.log(`Shoemaker dashboard listening on http://${config.host}:${config.port}${BASE}`);
  });
}
