// Generate the secrets BizTrace's sign-in needs.
//
//   node scripts/make-password-hash.js            → prompts for a password,
//                                                   prints its hash
//   node scripts/make-password-hash.js --secret   → prints a SESSION_SECRET
//
// The password is TYPED IN, not passed as an argument, for two reasons that
// both bit us:
//
//   1. Quoting. A password containing " or ' is cut short by the shell, so the
//      hash ends up covering a different string than the one you saved in your
//      password manager — and the only symptom is that sign-in never works.
//   2. History. An argument is written to PowerShell's history file in plain
//      text and is visible in the process list while it runs. That is a poor
//      home for the password guarding the whole company database.
//
// Typing is echoed as * and never leaves this process.

const crypto = require('crypto');
const path = require('path');
const { hashPassword } = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'auth.js'));

function printSecret() {
  console.log(`
SESSION_SECRET — signs the session cookie. One value for the whole site.
Rotating it signs everybody out immediately, which is the lever to pull if a
laptop is lost or someone leaves.

  SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}

Then run this again with no arguments to make a password hash for each account.
`);
}

// Read a line without echoing it back.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error('No terminal available — run this in PowerShell or a terminal directly.'));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = ch => {
      switch (ch) {
        case '\n': case '\r': case '\u0004':      // done
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value);
          break;
        case '\u0003':                            // ctrl-c
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(1);
          break;
        case '\u007f': case '\b':                 // backspace
          if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); }
          break;
        default:
          // Ignore other control characters; take everything else verbatim,
          // so quotes, #, $ and spaces all survive exactly as typed.
          if (ch >= ' ') { value += ch; stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  if (process.argv[2] === '--secret') { printSecret(); return; }

  if (process.argv[2]) {
    console.error(`
Don't pass the password as an argument — it goes into your shell history in
plain text, and a " or ' in it gets cut short by the shell without telling you.

Run it with no arguments and type the password when asked:

  node scripts/make-password-hash.js
`);
    process.exitCode = 1;
    return;
  }

  const pw = await askHidden('Password (typing is hidden): ');
  if (pw.length < 12) {
    console.error(`\nThat password is ${pw.length} character${pw.length === 1 ? '' : 's'}. Use at least 12.`);
    console.error('This one guards the whole company database, and a short password is');
    console.error('the weak link no matter how carefully it is hashed.\n');
    process.exitCode = 1;
    return;
  }

  const again = await askHidden('Type it again to confirm:     ');
  if (again !== pw) {
    console.error('\nThose did not match. Nothing generated — run it again.\n');
    console.error('(Worth catching here: a typo would produce a hash for a password');
    console.error('you do not know, and the only symptom would be sign-in failing.)\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\n${hashPassword(pw)}\n`);
  console.log('Paste that whole line into Netlify as STAFF_PASSWORD_HASH or');
  console.log('ADMIN_PASSWORD_HASH. The password itself is not stored anywhere —');
  console.log('save it in your password manager now.\n');
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
