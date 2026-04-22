// Minimal cookie-session auth.
//
// Philosophy: we don't want to pull in argon2 (native build) or jsonwebtoken
// (extra dep) for a project that is still single-user scale. Node's built-in
// `crypto` module gives us everything:
//   · `scryptSync` for password hashing (CPU-hard, salt-per-user).
//   · `createHmac` for session token signing (stateless, no DB hit per request).
//
// The session token is `base64url({user_id, exp}).base64url(hmac)`.
// It is stored in an HttpOnly, SameSite=Lax cookie; tampering is detected
// via HMAC. Cookies expire in 30 days (refreshed on each request).
//
// Anonymous users get a long-lived random cookie `kontur_client` which is
// used as the `owner_key` for their watchlist/alerts so they can use the
// product without signing up.

import crypto from 'node:crypto';
import { getDb } from '../db/index.js';

const SESSION_MS = 30 * 24 * 3600 * 1000;

function secret() {
  return process.env.KONTUR_SECRET
    || process.env.FIRMENBUCH_TOKEN  // pragmatic fallback in single-user mode
    || 'kontur-dev-secret-override-in-prod';
}

function b64(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64(s) { return Buffer.from(s, 'base64url'); }

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 2 ** 14, r: 8, p: 1 }).toString('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = hash(password, salt);
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, h] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !h) return false;
  const candidate = hash(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(h, 'hex'));
}

export function signSession(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(unb64(body).toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export function sessionCookie(userId) {
  const token = signSession({ uid: userId, exp: Date.now() + SESSION_MS });
  return {
    name: 'kontur_session',
    value: token,
    options: {
      httpOnly: true, sameSite: 'lax',
      maxAge: SESSION_MS,
      secure: process.env.KONTUR_SECURE === '1',
    },
  };
}

// Attach `req.user` and `req.clientKey` to every request.
export function authMiddleware(req, res, next) {
  req.user = null;
  req.clientKey = null;

  const cookies = parseCookies(req.headers.cookie || '');

  // 1. Signed session (logged-in user)
  const session = cookies.kontur_session ? verifySession(cookies.kontur_session) : null;
  if (session?.uid) {
    const row = getDb().prepare('SELECT id, email FROM users WHERE id = ?').get(session.uid);
    if (row) { req.user = row; req.clientKey = `user:${row.id}`; }
  }

  // 2. Anonymous long-lived client cookie
  if (!req.clientKey) {
    let anon = cookies.kontur_client;
    if (!anon || anon.length < 20) {
      anon = crypto.randomBytes(16).toString('base64url');
      res.setHeader('Set-Cookie', serializeCookie('kontur_client', anon, {
        httpOnly: true, sameSite: 'lax',
        maxAge: 365 * 24 * 3600 * 1000,
        secure: process.env.KONTUR_SECURE === '1',
      }));
    }
    req.clientKey = `anon:${anon}`;
  }
  next();
}

export function setSessionCookie(res, userId) {
  const c = sessionCookie(userId);
  const existing = res.getHeader('Set-Cookie');
  const serialized = serializeCookie(c.name, c.value, c.options);
  const merged = Array.isArray(existing) ? existing.concat(serialized)
               : existing ? [existing, serialized]
               : serialized;
  res.setHeader('Set-Cookie', merged);
}

export function clearSessionCookie(res) {
  const ser = serializeCookie('kontur_session', '', { httpOnly: true, sameSite: 'lax', maxAge: 0 });
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', Array.isArray(existing) ? existing.concat(ser) : existing ? [existing, ser] : ser);
}

function parseCookies(header) {
  const out = {};
  for (const p of header.split(/;\s*/)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1));
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) {
    parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    parts.push(`Expires=${new Date(Date.now() + opts.maxAge).toUTCString()}`);
  }
  parts.push('Path=/');
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
