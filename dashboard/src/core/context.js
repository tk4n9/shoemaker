// Per-request context handed to every feature handler. This is the feature API
// surface — keep it small and stable so feature modules rarely need core changes.
import { layout } from './layout.js';
import { parseBody, send, json, redirect } from './http.js';
import { config } from '../config.js';

export function makeContext({ req, res, url, params, db, runtime, navItems }) {
  let bodyPromise;
  const getSettings = () => db.prepare('SELECT * FROM config WHERE id = 1').get();

  return {
    req, res, url, params, db,
    runtime,                      // dashboard.json values (project, port, target_dir, ...)
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    navItems,

    body: () => (bodyPromise ??= parseBody(req)),   // memoized; await it
    settings: getSettings,        // db config row (project_name, theme, show_completed, todo_view)

    send: (status, body, headers) => send(res, status, body, headers),
    json: (status, obj, headers) => json(res, status, obj, headers),
    redirect: (location, headers) => redirect(res, config.base_path + location, headers),
    notFound: (msg = 'Not found') => send(res, 404, msg),

    // Render a full HTML page with shared chrome (nav + theme).
    page: ({ title, body, bare = false }) => {
      const s = getSettings();
      send(res, 200, layout({
        title, body, theme: s.theme, align: s.container_align, navItems, activePath: url.pathname, bare,
      }));
    },
  };
}
