// Regression tests for filters that quietly returned the wrong rows.
//
//   F1  Reg. Date and Account Due Date wrote both bounds to the same key with
//       no merge, so the second assignment plainly overwrote the first and the
//       "From" bound vanished. Setting 2018-2020 returned everything before
//       2020, back to the 1960s.
//   F2  Where a merge WAS attempted, the two conditions were chained into one
//       value ("gte.X&col=lte.Y") that pgrestParamsToTurso could not read
//       back: it took the first operator and swallowed the rest into the value
//       string. Four user actions were affected — overdue+range, AR From+To,
//       officers min+max (always zero rows), officers max-only (no filter).
//   F3  'na' is the missing-value marker and sorts above every digit, so
//       `annual_return_date >= '2025-01-01'` was true for the 63% of rows that
//       have no annual return date at all.
//
// This runs the whole path: buildParams-style conditions -> addCond ->
// pgrestParamsToTurso -> query.js buildWhere -> real SQL over real rows. A
// test that stopped at the filter objects would have missed F3 entirely.
//
// No dependencies (node:sqlite is built in). Run:
//   node scripts/test-filter-combining.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function extractFunction(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = src.search(re);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Frontend side: addCond + the converter, lifted out of index.html.
const fe = { console, Object, String, Array, Number, Set, Map, JSON };
fe.globalThis = fe;
vm.createContext(fe);
vm.runInContext(
  ['addCond', 'pgrestParamsToTurso', 'pushFilter'].map(n => extractFunction(HTML, n)).join('\n\n'),
  fe);

// Proxy side: query.js's real buildWhere.
const query = require(path.join(ROOT, 'netlify/functions/query.js'));
const buildWhere = query.__test__ && query.__test__.buildWhere;

// A small table shaped like the real one: dates and officer counts, with 'na'
// standing in for missing exactly as ACRA writes it.
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE companies (
    uen TEXT PRIMARY KEY,
    annual_return_date TEXT,
    registration_incorporation_date TEXT,
    account_due_date TEXT,
    no_of_officers TEXT,
    entity_name TEXT
  );
  INSERT INTO companies VALUES
    ('C1','2025-06-30','2019-03-01','2025-09-30','7','IN RANGE PTE LTD'),
    ('C2','2025-11-15','2018-07-22','2025-11-30','3','IN RANGE TOO PTE LTD'),
    ('C3','2024-02-01','2015-01-10','2024-03-31','25','TOO EARLY PTE LTD'),
    ('C4','2026-12-01','2022-05-05','2026-12-31','12','TOO LATE PTE LTD'),
    ('C5','na','1984-09-04','na','na','NO DATES PTE LTD'),
    ('C6','na','2021-01-01','na','9','A & B PTE LTD');
`);

// Run a params object end to end and return the matching uens.
function runOn(conn, params, table = 'companies') {
  const turso = fe.pgrestParamsToTurso(params);
  const { sql, args } = buildWhere(turso.filters, false);
  const where = sql ? `WHERE ${sql}` : '';
  return conn.prepare(`SELECT uen FROM ${table} ${where} ORDER BY uen`).all(...args).map(r => r.uen);
}
const run = params => runOn(db, params);

// The same officer counts under a chosen column declaration, so the numeric
// comparison can be checked against both plausible schemas.
function officersTable(decl) {
  const c = new DatabaseSync(':memory:');
  c.exec(`CREATE TABLE companies (uen TEXT PRIMARY KEY, no_of_officers ${decl});`);
  // 'na' is inserted as text in both cases — SQLite keeps it verbatim even on
  // an INTEGER column, which is exactly how the real data behaves.
  c.exec(`INSERT INTO companies VALUES
    ('C1','7'),('C2','3'),('C3','25'),('C4','12'),('C5','na'),('C6','9');`);
  return c;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nF1 — both bounds of a date range survive');
{
  const p = {};
  fe.addCond(p, 'registration_incorporation_date', 'gte.2018-01-01');
  fe.addCond(p, 'registration_incorporation_date', 'lte.2020-12-31');
  const got = run(p);
  check('Reg. Date 2018-2020 excludes 1984 and 2015', eq(got, ['C1', 'C2']), `got ${got}`);

  const p2 = {};
  fe.addCond(p2, 'account_due_date', 'gte.2025-01-01');
  fe.addCond(p2, 'account_due_date', 'lte.2025-12-31');
  const got2 = run(p2);
  check('Account Due 2025 excludes 2024 and 2026', eq(got2, ['C1', 'C2']), `got ${got2}`);
}

console.log('\nF2 — the four broken combinations');
{
  const today = '2026-09-15';

  const p = {};
  fe.addCond(p, 'annual_return_date', `lt.${today}`);
  fe.addCond(p, 'annual_return_date', 'gte.2025-01-01');
  fe.addCond(p, 'annual_return_date', 'lte.2025-12-31');
  const got = run(p);
  check('Overdue only + a 2025 range honours the range', eq(got, ['C1', 'C2']), `got ${got}`);

  const p2 = {};
  fe.addCond(p2, 'annual_return_date', 'gte.2025-01-01');
  fe.addCond(p2, 'annual_return_date', 'lte.2025-12-31');
  check('AR From + To honours the To bound', eq(run(p2), ['C1', 'C2']), `got ${run(p2)}`);

  // Officer counts are compared numerically regardless of how the column was
  // declared. The `companies` table predates this repo's migrations, so the
  // real affinity is not recorded anywhere here — the fix has to hold either
  // way, and so does the test.
  for (const decl of ['TEXT', 'INTEGER']) {
    const t = officersTable(decl);
    const p3 = {};
    fe.addCond(p3, 'no_of_officers', 'gte.5');
    fe.addCond(p3, 'no_of_officers', 'lte.20');
    const got3 = runOn(t, p3);
    check(`Officers 5-20 is numeric on a ${decl} column`, eq(got3, ['C1', 'C4', 'C6']), `got ${got3}`);

    const p4 = {};
    fe.addCond(p4, 'no_of_officers', 'lte.10');
    const got4 = runOn(t, p4);
    check(`Officers max-only filters on a ${decl} column`, eq(got4, ['C1', 'C2', 'C6']), `got ${got4}`);
    check(`...and excludes the 'na' row on a ${decl} column`,
          !got4.includes('C5'), `got ${got4}`);
  }
}

console.log("\nF3 — 'na' is not a value in a range");
{
  const p = {};
  fe.addCond(p, 'annual_return_date', 'gte.2025-01-01');
  const got = run(p);
  check('AR From-only excludes the no-date rows', eq(got, ['C1', 'C2', 'C4']), `got ${got}`);
  check('...specifically C5 and C6 are absent',
        !got.includes('C5') && !got.includes('C6'), `got ${got}`);

  const p2 = {};
  fe.addCond(p2, 'annual_return_date', 'lt.2026-09-15');
  const got2 = run(p2);
  check('Overdue only still excludes no-date rows', eq(got2, ['C1', 'C2', 'C3']), `got ${got2}`);
}

console.log('\nEncoding edge cases');
{
  // A bare "&" in a value must not be read as a condition boundary.
  const p = { entity_name: 'ilike.*A & B*' };
  const f = fe.pgrestParamsToTurso(p).filters;
  check('a company name containing "&" survives the split',
        f.length === 1 && f[0].value === 'A & B', JSON.stringify(f));
  check('and still matches', eq(run(p), ['C6']), `got ${run(p)}`);

  // A single condition must behave exactly as before.
  const one = fe.pgrestParamsToTurso({ annual_return_date: 'gte.2025-01-01' }).filters;
  check('a single condition still yields exactly one filter',
        one.length === 1 && one[0].op === 'gte', JSON.stringify(one));

  // addCond itself.
  const p2 = {};
  fe.addCond(p2, 'x', 'gte.1');
  check('first condition is stored bare', p2.x === 'gte.1', p2.x);
  fe.addCond(p2, 'x', 'lte.9');
  check('second is chained with the column name', p2.x === 'gte.1&x=lte.9', p2.x);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
