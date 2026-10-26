// Tiny path router. Compiles `/todos/:id/comments` style patterns to regexes
// and matches a (method, path) pair, extracting named params.

export function compile(pattern) {
  const keys = [];
  const source = pattern.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { rx: new RegExp(`^${source}$`), keys };
}

// `routes` items: { method, path, handler, public?, _c? }. Mutates to add _c cache.
export function matchRoute(routes, method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (!r._c) r._c = compile(r.path);
    const m = path.match(r._c.rx);
    if (m) {
      const params = {};
      r._c.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return null;
}
