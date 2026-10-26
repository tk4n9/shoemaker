// Low-level HTTP helpers shared by all features. No app logic here.
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const MIME = {
  '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function readRaw(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

// Parse a request body as JSON or urlencoded form. Returns an object.
export async function parseBody(req) {
  const raw = await readRaw(req);
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  const out = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

// Serve a file from `dir` for a request path like `/static/app.css` (prefix stripped).
export async function serveStatic(res, dir, relRaw) {
  const rel = normalize(relRaw).replace(/^(\.\.[/\\])+/, '');
  const file = join(dir, rel);
  if (!file.startsWith(dir)) return send(res, 403, 'Forbidden');
  try {
    const buf = await readFile(file);
    send(res, 200, buf, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}
