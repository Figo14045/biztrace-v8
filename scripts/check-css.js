// Guard against the CSS damage that broke the UI twice.
//
// Removing a feature meant deleting a run of rules, and a range delete is
// blunt: it took the nav button styles and the `body` rule with it, because
// both happened to sit under a comment header named after the feature being
// removed. Neither is caught by a JS syntax check, and the tests all passed —
// the page simply fell apart in the browser.
//
// This checks the things that must be true of the stylesheet no matter what.
//
// Run: node scripts/check-css.js

const fs = require('fs');
const path = require('path');

const s = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = s.slice(s.indexOf('<style>') + 7, s.indexOf('</style>'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// 1. Balanced braces. One stray '}' silently kills every rule after it, which
//    is what collapsed the sidebar.
const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
check('braces are balanced', open === close, `${open} open, ${close} close`);

// 2. The rules the layout actually hangs on. `body` is the one that went
//    missing: an element selector, so a check that only looked for "." and "#"
//    could not see it.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
for (const sel of ['body', '#app-shell', '#header', '#layout', '#sidebar', '#main', '#viewnav', '.navbtn']) {
  const re = new RegExp('(?:^|\\n|,)\\s*' + sel.replace(/[.#]/g, ch => '\\' + ch) + '\\s*[,{:]');
  check(`${sel} has a rule`, re.test(bare));
}

// 3. The height chain. Each of these must keep passing height down, or the
//    page collapses to the height of its content.
const rule = sel => {
  const m = bare.match(new RegExp('(?:^|\\n)' + sel.replace(/[.#]/g, c => '\\' + c) + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
};
check('body fills the viewport and stacks', /height:\s*100vh/.test(rule('body')) && /display:\s*flex/.test(rule('body')));
check('#app-shell passes the height on', /flex:\s*1/.test(rule('#app-shell')) && /min-height:\s*0/.test(rule('#app-shell')));
check('#layout claims the remaining space', /flex:\s*1/.test(rule('#layout')));

// 4. The hidden attribute must win over any display rule.
check('[hidden] is enforced with !important',
      /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));

// 5. Nothing references a class the stylesheet no longer defines, for the
//    classes that carry layout rather than decoration.
for (const cls of ['navbtn', 'sp-card', 'signin-card', 'filter-group']) {
  const used = new RegExp('class="[^"]*\\b' + cls + '\\b').test(s);
  const defined = new RegExp('\\.' + cls + '\\s*[,{:]').test(bare);
  check(`.${cls} is defined if it is used`, !used || defined,
        'markup uses it but the stylesheet does not define it');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
