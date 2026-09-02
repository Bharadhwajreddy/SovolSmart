import crypto from 'node:crypto';
import { config } from './config.js';
import { logEvent } from './log.js';

const COOKIE_NAME = 'sv02_session';

/**
 * Constant-time password comparison. Hashing both sides first means the
 * comparison length is fixed regardless of the supplied password's length,
 * which timingSafeEqual otherwise leaks by throwing on a length mismatch.
 */
function passwordMatches(supplied) {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(config.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

/** Token format: `<expiryMillis>.<hmac>` — stateless, so restarts keep sessions. */
function createToken() {
  const expiry = String(Date.now() + config.sessionHours * 3600 * 1000);
  return `${expiry}.${sign(expiry)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;

  const expiry = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(expiry);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  return Number(expiry) > Date.now();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// --- Login throttling ------------------------------------------------------
// This app sits on a public tunnel, so an unthrottled password field is an
// open invitation. Per-IP, in-memory, resets on restart — enough for a
// single-user tool without dragging in a store.

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function throttled(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const record = attempts.get(ip);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    record.count += 1;
  }
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of attempts) {
    if (now - record.first > WINDOW_MS) attempts.delete(ip);
  }
}, WINDOW_MS).unref();

// --- Express glue ----------------------------------------------------------

export function handleLogin(req, res) {
  const ip = clientIp(req);

  if (throttled(ip)) {
    logEvent('warn', 'login_throttled', `Too many failed logins from ${ip}`);
    return res.status(429).json({
      error: 'Too many failed attempts. Wait 15 minutes and try again.',
    });
  }

  if (!passwordMatches(req.body?.password)) {
    recordFailure(ip);
    logEvent('warn', 'login_failed', `Failed login from ${ip}`);
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  attempts.delete(ip);
  logEvent('info', 'login_ok', `Login from ${ip}`);

  res.cookie(COOKIE_NAME, createToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.trustProxyHttps,
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/',
  });
  return res.json({ ok: true });
}

export function handleLogout(_req, res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}

export function isAuthenticated(req) {
  return verifyToken(parseCookies(req.headers.cookie).sv02_session);
}

/** Guard for every /api route except /api/login and /api/session. */
export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Not signed in.', unauthenticated: true });
}
