// BizTrace — authentication
//
// WHY THIS IS SERVER-SIDE
// A login rendered in index.html would stop nobody. The data lives behind
// /.netlify/functions/*, and until now every one of those was open to the
// internet with Access-Control-Allow-Origin: * and no check at all — a plain
// curl to /query returned the whole company table, and one to /enrich-save
// could spend the OpenRouter balance. Hiding the page while leaving the API
// open protects nothing. So the check lives here, and every function that
// touches data or money calls requireAuth() before doing anything else.
//
// HOW IT WORKS
//   POST /login {password}  → verifies against a hash in an env var, sets an
//                             HttpOnly session cookie
//   every other function    → requireAuth(event) or 401
//
// The session is a signed token, not a stored one: <payload>.<hmac>. There is
// no session table to keep, and a token cannot be forged without SESSION_SECRET.
// The trade-off is that a token cannot be revoked individually before it
// expires — to invalidate every session at once, rotate SESSION_SECRET.
//
// PASSWORDS are never stored, only scrypt hashes, and are compared in constant
// time so a wrong answer takes as long as a right one.

const crypto = require('crypto');

const SESSION_SECRET      = process.env.SESSION_SECRET || '';
const STAFF_PASSWORD_HASH = process.env.STAFF_PASSWORD_HASH || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

// 30 days. Long because this is a daily-use internal tool and an enrichment
// run can last hours — an expiry mid-run would be a bug, not security.
const SESSION_DAYS = 30;
const COOKIE_NAME = 'bt_session';

// ──────────────────────────────────────────────────────────────────────────
// Passwords
// ──────────────────────────────────────────────────────────────────────────
// Stored as  scrypt$<salt-hex>$<hash-hex>  — generate with
//   node scripts/make-password-hash.js
//
// scrypt rather than a plain SHA: a fast hash can be brute-forced offline at
// billions of guesses a second if the env var ever leaks, which is exactly how
// the Turso token got out.
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let candidate;
  try { candidate = hashPassword(password, parts[1]); }
  catch (e) { return false; }
  return timingSafeEqualStr(candidate, stored);
}

// Comparing with === leaks how many leading characters matched, through how
// long the comparison took. Lengths are padded first because timingSafeEqual
// throws on a length mismatch, which would itself be a signal.
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);   // keep the work constant
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ──────────────────────────────────────────────────────────────────────────
// Session tokens
// ──────────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signSession(user, nowMs = Date.now()) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  const payload = b64url(JSON.stringify({
    u: user,
    exp: nowMs + SESSION_DAYS * 24 * 60 * 60 * 1000,
  }));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

// Returns the user name, or null. Null covers every failure — bad signature,
// expired, malformed, missing secret — deliberately, so a caller cannot
// accidentally treat "expired" as "valid".
function verifySession(token, nowMs = Date.now()) {
  if (!token || !SESSION_SECRET) return null;
  const dot = String(token).lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  if (!timingSafeEqualStr(sig, expected)) return null;

  let data;
  try { data = JSON.parse(unb64url(payload).toString('utf8')); }
  catch (e) { return null; }

  if (!data || typeof data.exp !== 'number' || data.exp < nowMs) return null;
  if (data.u !== 'staff' && data.u !== 'admin') return null;
  return data.u;
}

// ──────────────────────────────────────────────────────────────────────────
// Cookies
// ──────────────────────────────────────────────────────────────────────────
// HttpOnly so a cross-site scripting bug cannot read the session; Secure so it
// never travels over plain HTTP; SameSite=Lax so another site cannot make an
// authenticated request on the user's behalf.
function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(event, name = COOKIE_NAME) {
  const header = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// The guard every protected function calls
// ──────────────────────────────────────────────────────────────────────────
// Returns { user } when the caller is authenticated, or { response } — an
// HTTP response to return immediately. Shaped this way so a function cannot
// forget to stop: `if (gate.response) return gate.response;` is one line and
// obviously load-bearing.
//
// If SESSION_SECRET is not configured the answer is 401, never "allow". A
// misconfigured deploy must fail closed; failing open would silently restore
// exactly the hole this closes.
function requireAuth(event, corsHeaders) {
  const headers = { ...(corsHeaders || {}), 'Content-Type': 'application/json' };

  if (!SESSION_SECRET || (!STAFF_PASSWORD_HASH && !ADMIN_PASSWORD_HASH)) {
    return { response: { statusCode: 401, headers, body: JSON.stringify({
      ok: false, error: 'Sign-in is not configured on the server', code: 'auth_not_configured' }) } };
  }

  const user = verifySession(readCookie(event));
  if (!user) {
    return { response: { statusCode: 401, headers, body: JSON.stringify({
      ok: false, error: 'Please sign in', code: 'unauthenticated' }) } };
  }
  return { user };
}

// CORS locked to this site.
//
// Access-Control-Allow-Origin: * let any page on the internet call these
// endpoints from a visitor's browser. Same-origin requests from BizTrace
// itself do not need a wildcard, so there is nothing to lose by removing it.
// URL is set by Netlify to the site's own address.
function corsHeaders(event) {
  const site = process.env.URL || '';
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allow = (site && origin === site) ? origin : site;
  return {
    'Access-Control-Allow-Origin': allow || 'null',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
}

module.exports = {
  COOKIE_NAME, SESSION_DAYS,
  hashPassword, verifyPassword,
  signSession, verifySession,
  sessionCookie, clearedCookie, readCookie,
  requireAuth, corsHeaders,
};
