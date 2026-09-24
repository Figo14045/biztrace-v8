// Generate the secrets BizTrace's sign-in needs.
//
//   node scripts/make-password-hash.js                 → a SESSION_SECRET
//   node scripts/make-password-hash.js "some password" → the hash for it
//
// Paste the output into Netlify → Site configuration → Environment variables.
// The plain password is never stored anywhere: only the scrypt hash goes into
// the environment, and the hash cannot be turned back into the password.
//
// Run it locally. Do not paste a real password into a chat, a ticket, or a
// commit — this repo has already had one secret committed by accident.

const crypto = require('crypto');
const path = require('path');
const { hashPassword } = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'auth.js'));

const arg = process.argv[2];

if (!arg) {
  console.log(`
SESSION_SECRET — signs the session cookie. One value for the whole site.
Rotating it signs everybody out immediately, which is the lever to pull if a
laptop is lost or someone leaves.

  SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}

Then generate a hash for each account:

  node scripts/make-password-hash.js "the staff password"   → STAFF_PASSWORD_HASH
  node scripts/make-password-hash.js "the admin password"   → ADMIN_PASSWORD_HASH
`);
  process.exitCode = 0;
} else {
  if (arg.length < 12) {
    console.error(`\nThat password is ${arg.length} characters. Use at least 12.`);
    console.error('This one guards the whole company database, and a short password');
    console.error('is the weak link regardless of how the hashing is done.\n');
    process.exitCode = 1;
  } else {
    console.log(`\n${hashPassword(arg)}\n`);
    console.log('Paste that as STAFF_PASSWORD_HASH or ADMIN_PASSWORD_HASH in Netlify.');
    console.log('The password itself is not stored — keep it in your password manager.\n');
  }
}
