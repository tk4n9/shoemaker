// Minimal single-password auth using a signed cookie (HMAC). LAN use.
// Auth is disabled (everything allowed) when no password is configured.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// One cookie per port: browsers share cookies across ports, and each project's
// dashboard has its own port and secret.
const COOKIE = `shoemaker_auth_${config.port}`;

function sign(value) {
  return createHmac('sha256', config.secret).update(value).digest('hex');
}
function makeToken() {
  const value = 'ok';
  return `${value}.${sign(value)}`;
}
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [value, sig] = token.split('.');
  const expected = sign(value);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authEnabled() {
  return Boolean(config.password);
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  if (!authEnabled()) return true;
  return validToken(parseCookies(req)[COOKIE]);
}

export function checkPassword(pw) {
  if (!authEnabled()) return true;
  const a = Buffer.from(pw || '');
  const b = Buffer.from(config.password);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authCookieHeader() {
  // 7-day cookie. HttpOnly; SameSite=Lax. (No Secure: LAN/HTTP.)
  return `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`;
}
