// BizTrace — sign in, check, sign out.
//
//   POST   /.netlify/functions/login  { password }  → sets the session cookie
//   GET    /.netlify/functions/login                → { ok, user } or 401
//   DELETE /.netlify/functions/login                → clears the cookie
//
// Two accounts, same privileges: 'staff' (shared by the team) and 'admin'.
// They are told apart only by which password was used, which is what makes it
// possible to rotate the shared one without locking the admin out, and lets
// the logs say which was in use.

const auth = require('./lib/auth.js');

const STAFF_PASSWORD_HASH = process.env.STAFF_PASSWORD_HASH || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

// A wrong password should not be cheap to try in bulk. There is no shared
// store across function instances to rate-limit properly, so this is a floor
// rather than a defence: it makes an online guessing run slow without
// affecting anyone typing a password by hand. The real protection is scrypt,
// which makes an offline attack on a leaked hash expensive.
const WRONG_PASSWORD_DELAY_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async function (event) {
  const headers = auth.corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Is this browser signed in? Used on page load to decide whether to show
  // the sign-in screen.
  if (event.httpMethod === 'GET') {
    // Report a server with no passwords set as exactly that, rather than as
    // "signed out". They look identical from the browser but mean opposite
    // things: one is fixed by typing a password, the other cannot be fixed by
    // the person typing at all. Saying "please sign in" to someone facing a
    // box that can never accept anything wastes their time — which it did.
    if (!process.env.SESSION_SECRET || (!STAFF_PASSWORD_HASH && !ADMIN_PASSWORD_HASH)) {
      return { statusCode: 401, headers, body: JSON.stringify({
        ok: false,
        code: 'auth_not_configured',
        session_secret_set: !!process.env.SESSION_SECRET,
        staff_hash_set: !!STAFF_PASSWORD_HASH,
        admin_hash_set: !!ADMIN_PASSWORD_HASH,
      }) };
    }

    const user = auth.verifySession(auth.readCookie(event));
    if (!user) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, code: 'unauthenticated' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, user }) };
  }

  if (event.httpMethod === 'DELETE') {
    return {
      statusCode: 200,
      headers: { ...headers, 'Set-Cookie': auth.clearedCookie() },
      body: JSON.stringify({ ok: true, signed_out: true })
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  // Fail closed on a misconfigured deploy. Treating "no passwords set" as
  // "let everyone in" would silently reopen the hole this exists to close.
  if (!process.env.SESSION_SECRET || (!STAFF_PASSWORD_HASH && !ADMIN_PASSWORD_HASH)) {
    return { statusCode: 500, headers, body: JSON.stringify({
      ok: false,
      error: 'Sign-in is not configured on the server',
      code: 'auth_not_configured',
      session_secret_set: !!process.env.SESSION_SECRET,
      staff_hash_set: !!STAFF_PASSWORD_HASH,
      admin_hash_set: !!ADMIN_PASSWORD_HASH,
    }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Password required' }) };
  }

  // Admin is checked first, but BOTH are always evaluated so the time taken
  // does not reveal which account a password matched.
  const isAdmin = auth.verifyPassword(password, ADMIN_PASSWORD_HASH);
  const isStaff = auth.verifyPassword(password, STAFF_PASSWORD_HASH);
  const user = isAdmin ? 'admin' : (isStaff ? 'staff' : null);

  if (!user) {
    await sleep(WRONG_PASSWORD_DELAY_MS);
    // Deliberately vague: naming which account exists would help someone
    // guessing, and there is nothing here the person typing needs to know.
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Incorrect password' }) };
  }

  const token = auth.signSession(user);
  return {
    statusCode: 200,
    headers: { ...headers, 'Set-Cookie': auth.sessionCookie(token, auth.SESSION_DAYS * 24 * 60 * 60) },
    body: JSON.stringify({ ok: true, user })
  };
};
