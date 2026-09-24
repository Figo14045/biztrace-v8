// Tests for sign-in.
//
// The claim worth defending is not "there is a login screen" — it is that the
// DATA is unreachable without one. Before this, every function answered anyone
// on the internet: a curl to /query returned the company table, and one to
// /enrich-save could spend the OpenRouter balance. A password on index.html
// would not have changed that, because nothing forces a caller to load the
// page.
//
// So most of these tests call the real handlers with no cookie and check they
// refuse, and check that a misconfigured server fails CLOSED rather than open.
//
// Run: node scripts/test-auth.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCS = path.join(ROOT, 'netlify', 'functions');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Configure a realistic environment BEFORE requiring anything that reads it.
process.env.SESSION_SECRET = 'test-secret-not-a-real-one-0123456789abcdef';
process.env.URL = 'https://biztracev8.netlify.app';

const auth = require(path.join(FUNCS, 'lib', 'auth.js'));
process.env.STAFF_PASSWORD_HASH = auth.hashPassword('correct-horse-staff');
process.env.ADMIN_PASSWORD_HASH = auth.hashPassword('correct-horse-admin!');

// ── Passwords ────────────────────────────────────────────────────────────
console.log('\nPasswords');
{
  const h = auth.hashPassword('a-long-enough-password');
  check('a hash is scrypt with a salt', /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(h), h.slice(0, 20));
  check('the same password hashes differently each time (random salt)',
        auth.hashPassword('a-long-enough-password') !== h);
  check('the right password verifies', auth.verifyPassword('a-long-enough-password', h));
  check('the wrong password does not', !auth.verifyPassword('a-long-enough-passwore', h));
  check('an empty password does not', !auth.verifyPassword('', h));
  check('a missing hash rejects rather than accepts', !auth.verifyPassword('anything', ''));
  check('a malformed hash rejects', !auth.verifyPassword('x', 'notascrypthash'));
  check('the plaintext is nowhere in the hash', !h.includes('a-long-enough-password'));

  // Pasted into a web form by hand, these values pick up invisible whitespace.
  // An exact comparison then fails as "Incorrect password", pointing the user
  // at the one thing that is not wrong.
  check('a hash with a trailing newline still verifies', auth.verifyPassword('a-long-enough-password', h + '\n'));
  check('a hash with surrounding spaces still verifies', auth.verifyPassword('a-long-enough-password', `  ${h}  `));
  check('trimming does not make a wrong password work',
        !auth.verifyPassword('not-the-password', h + '\n'));
  check('a truncated hash is still rejected', !auth.verifyPassword('a-long-enough-password', h.slice(0, -4)));
  check('a full hash is 104 characters (so a short paste is visible)', h.length === 104, String(h.length));
}

// ── Session tokens ───────────────────────────────────────────────────────
console.log('\nSession tokens');
{
  const t = auth.signSession('staff');
  check('a fresh token verifies', auth.verifySession(t) === 'staff');
  check('an admin token carries admin', auth.verifySession(auth.signSession('admin')) === 'admin');

  // Tamper with the payload: the signature must stop it.
  const [payload, sig] = t.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 1e9 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('a re-written payload is rejected', auth.verifySession(`${forgedPayload}.${sig}`) === null);
  check('a tampered signature is rejected', auth.verifySession(`${payload}.${sig.slice(0, -2)}xx`) === null);
  check('a token with no signature is rejected', auth.verifySession(payload) === null);
  check('garbage is rejected', auth.verifySession('nonsense') === null);
  check('an empty token is rejected', auth.verifySession('') === null);

  // Expiry is enforced, and "expired" is never mistaken for "valid".
  const old = auth.signSession('staff', Date.now() - 31 * 24 * 3600 * 1000);
  check('an expired token is rejected', auth.verifySession(old) === null);
  check('a 30-day-old token is still inside the window',
        auth.verifySession(auth.signSession('staff', Date.now() - 29 * 24 * 3600 * 1000)) === 'staff');

  // A token signed with a different secret must not pass — this is what makes
  // rotating SESSION_SECRET sign everyone out.
  const realSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-different-secret';
  delete require.cache[require.resolve(path.join(FUNCS, 'lib', 'auth.js'))];
  const auth2 = require(path.join(FUNCS, 'lib', 'auth.js'));
  check('rotating the secret invalidates existing tokens', auth2.verifySession(t) === null);
  process.env.SESSION_SECRET = realSecret;
  delete require.cache[require.resolve(path.join(FUNCS, 'lib', 'auth.js'))];
}

// ── Cookies ──────────────────────────────────────────────────────────────
console.log('\nCookies');
{
  const c = auth.sessionCookie('abc', 100);
  check('the cookie is HttpOnly (script cannot read it)', /HttpOnly/.test(c));
  check('the cookie is Secure (never sent over plain HTTP)', /Secure/.test(c));
  check('the cookie is SameSite (another site cannot use it)', /SameSite=Lax/.test(c));
  check('signing out expires the cookie', /Max-Age=0/.test(auth.clearedCookie()));
  check('a cookie is read out of the header',
        auth.readCookie({ headers: { cookie: 'other=1; bt_session=xyz; z=2' } }) === 'xyz');
  check('a missing cookie reads as null', auth.readCookie({ headers: {} }) === null);
}

// ── The gate on every function ───────────────────────────────────────────
console.log('\nThe gate');

const PROTECTED = ['query.js', 'enrich-save.js', 'openrouter-enrich.js',
                   'ai-enrich.js', 'claude-enrich.js', 'serp.js', 'fetch-contact.js'];

async function callFn(file, event) {
  delete require.cache[require.resolve(path.join(FUNCS, file))];
  const mod = require(path.join(FUNCS, file));
  return mod.handler(event);
}

(async () => {
  const signedIn = { headers: { cookie: `bt_session=${auth.signSession('staff')}` } };

  for (const file of PROTECTED) {
    const res = await callFn(file, { httpMethod: 'POST', body: '{}', headers: {} });
    check(`${file} refuses an unauthenticated POST`, res.statusCode === 401,
          `got ${res.statusCode}`);
  }

  // A signed-in caller must get PAST the gate. It may then fail for its own
  // reasons (no database configured in this test), but it must not be 401.
  const res = await callFn('query.js', { ...signedIn, httpMethod: 'POST', body: '{}' });
  check('a signed-in caller gets past the gate', res.statusCode !== 401, `got ${res.statusCode}`);

  // Preflight must stay open or the browser cannot ask permission to call.
  const pre = await callFn('query.js', { httpMethod: 'OPTIONS', headers: {} });
  check('CORS preflight is still answered', pre.statusCode === 200, `got ${pre.statusCode}`);

  // No wildcard CORS left anywhere.
  for (const file of PROTECTED) {
    const src = fs.readFileSync(path.join(FUNCS, file), 'utf8');
    const guarded = /auth\.requireAuth\(event/.test(src);
    check(`${file} calls requireAuth`, guarded);
  }

  // ── Fails closed ───────────────────────────────────────────────────────
  console.log('\nMisconfiguration fails closed');
  {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    delete require.cache[require.resolve(path.join(FUNCS, 'lib', 'auth.js'))];
    const a = require(path.join(FUNCS, 'lib', 'auth.js'));
    const gate = a.requireAuth({ headers: {} }, {});
    check('no SESSION_SECRET means 401, not open access',
          gate.response && gate.response.statusCode === 401);
    check('...and says why, so it is diagnosable',
          /auth_not_configured/.test(gate.response.body));
    process.env.SESSION_SECRET = saved;
    delete require.cache[require.resolve(path.join(FUNCS, 'lib', 'auth.js'))];
  }

  // ── login.js ───────────────────────────────────────────────────────────
  console.log('\nSign in endpoint');
  {
    const login = ev => callFn('login.js', ev);

    let r = await login({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'correct-horse-staff' }) });
    check('the staff password signs in', r.statusCode === 200 && JSON.parse(r.body).user === 'staff',
          `${r.statusCode} ${r.body}`);
    check('a session cookie is set', /bt_session=/.test(r.headers['Set-Cookie'] || ''));

    r = await login({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'correct-horse-admin!' }) });
    check('the admin password signs in as admin', JSON.parse(r.body).user === 'admin');

    r = await login({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'wrong' }) });
    check('a wrong password is refused', r.statusCode === 401);
    check('no cookie is set on a failed attempt', !(r.headers && r.headers['Set-Cookie']));
    check('the error does not say which account exists',
          !/staff|admin/i.test(JSON.parse(r.body).error || ''), JSON.parse(r.body).error);

    r = await login({ httpMethod: 'GET', headers: {} });
    check('a signed-out browser is told so', r.statusCode === 401);
    check('...and it is reported as signed-out, not as misconfigured',
          JSON.parse(r.body).code === 'unauthenticated', r.body);

    // The session check must distinguish "no passwords on the server" from
    // "please sign in". They look the same in the browser and mean opposite
    // things — one the user can fix by typing, the other they cannot.
    {
      const savedStaff = process.env.STAFF_PASSWORD_HASH;
      const savedAdmin = process.env.ADMIN_PASSWORD_HASH;
      delete process.env.STAFF_PASSWORD_HASH;
      delete process.env.ADMIN_PASSWORD_HASH;
      const res = await login({ httpMethod: 'GET', headers: {} });
      const j = JSON.parse(res.body);
      check('a server with no passwords says so on the session check',
            j.code === 'auth_not_configured', res.body);
      check('...and names which variables are missing, so it is fixable',
            j.staff_hash_set === false && j.session_secret_set === true, res.body);
      process.env.STAFF_PASSWORD_HASH = savedStaff;
      process.env.ADMIN_PASSWORD_HASH = savedAdmin;
    }

    r = await login({ httpMethod: 'GET', headers: { cookie: `bt_session=${auth.signSession('admin')}` } });
    check('a signed-in browser is recognised', r.statusCode === 200 && JSON.parse(r.body).user === 'admin');

    r = await login({ httpMethod: 'DELETE', headers: {} });
    check('signing out clears the cookie', /Max-Age=0/.test(r.headers['Set-Cookie'] || ''));
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
