// Regression test for the Auditor column filter.
//
// Two bugs, one test:
//
//   1. Filtering on has_auditor crashed with `no such column: "has_auditor"`.
//      has_auditor is a computed SELECT alias, not a stored column, and Turso
//      rejects an alias in a WHERE clause. This is the error one of the team
//      hit on a search that worked for everyone who hadn't touched that filter.
//
//   2. has_auditor was TRUE for every row. It excluded NULL and '' but not
//      'na', which is what ACRA writes for a missing value: 816,889 of the
//      817,218 sampled August rows carry 'na' there and only 329 name a real
//      audit firm. The AUDITED badge was on all 2.1M companies.
//
// No dependencies — uses node:sqlite, built into Node. Run it with:
//   node scripts/test-has-auditor.js

const mockTurso = require('./lib/mock-turso.js');

const SCHEMA = `
  CREATE TABLE companies (
    uen TEXT PRIMARY KEY,
    entity_name TEXT,
    entity_status_description TEXT,
    uen_of_audit_firm1 TEXT,
    name_of_audit_firm1 TEXT
  );
  INSERT INTO companies VALUES
    ('A1','REAL AUDITOR PTE LTD','Live','197300123K','SOME AUDIT LLP'),
    ('A2','NA MARKER PTE LTD','Live','na','na'),
    ('A3','EMPTY STRING PTE LTD','Live','',''),
    ('A4','NULL AUDITOR PTE LTD','Live',NULL,NULL),
    ('A5','SECOND REAL PTE LTD','Live','200412345W','OTHER AUDIT PAC');
`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  process.env.TURSO_URL = 'https://mock.invalid';
  process.env.TURSO_AUTH_TOKEN = 'test';

  const mock = mockTurso.install(SCHEMA);
  const { handler } = require('../netlify/functions/query.js');
  const post = body => handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  const uensOf = json => JSON.stringify((json.rows || []).map(r => r.uen).sort());

  const withCol = {
    fields: ['uen', 'entity_name', 'has_auditor'],
    sort: { field: 'uen', dir: 'asc' },
    limit: 50,
  };

  try {
    // 1. The exact production failure: filter on has_auditor while it is NOT
    //    in the requested field list. SQLite lets a WHERE clause reference a
    //    SELECT alias as a non-standard extension, so the bug only surfaces
    //    when the alias is absent — which is the normal case, because the
    //    frontend asks for a fixed set of display columns that excludes it.
    //    Selecting it as well would hide the failure.
    let res = await post({
      fields: ['uen', 'entity_name'],
      sort: { field: 'uen', dir: 'asc' },
      limit: 50,
      filters: [{ field: 'has_auditor', op: 'eq', value: 'true' }],
    });
    let json = JSON.parse(res.body);
    check('filter on has_auditor without selecting it does not error',
          res.statusCode === 200 && !json.error, `${res.statusCode} ${json.error || ''}`);

    // Belt and braces: assert on the SQL too. The check above depends on the
    // bundled SQLite rejecting an unresolvable double-quoted identifier, which
    // is a build flag we don't control (see lib/mock-turso.js). This one holds
    // regardless.
    check('WHERE references the real column, not the alias',
          !/has_auditor/.test(mock.lastWhere()) && /uen_of_audit_firm1/.test(mock.lastWhere()),
          `WHERE was:${mock.lastWhere()}`);
    check('...and still filters correctly', uensOf(json) === '["A1","A5"]', `got ${uensOf(json)}`);

    // 2. The same filter with the column selected — the path that worked by
    //    accident before, and must keep working.
    res = await post({ ...withCol, filters: [{ field: 'has_auditor', op: 'eq', value: 'true' }] });
    json = JSON.parse(res.body);
    check('filter on has_auditor while selecting it does not error',
          res.statusCode === 200 && !json.error, `${res.statusCode} ${json.error || ''}`);
    check('eq.true returns only real auditors', uensOf(json) === '["A1","A5"]', `got ${uensOf(json)}`);

    // 3. eq.false must include the 'na' rows. This is the whole of bug 2:
    //    before the fix this set was empty and every company looked audited.
    res = await post({ ...withCol, filters: [{ field: 'has_auditor', op: 'eq', value: 'false' }] });
    json = JSON.parse(res.body);
    check("eq.false includes the 'na' rows", uensOf(json) === '["A2","A3","A4"]', `got ${uensOf(json)}`);

    // 4. neq mirrors eq, since the frontend may emit either.
    res = await post({ ...withCol, filters: [{ field: 'has_auditor', op: 'neq', value: 'true' }] });
    json = JSON.parse(res.body);
    check('neq.true matches eq.false', uensOf(json) === '["A2","A3","A4"]', `got ${uensOf(json)}`);

    // 5. The SELECTed value agrees with the filter, so the AUDITED badge and
    //    the Auditor filter cannot disagree about the same row.
    res = await post({ ...withCol, filters: [] });
    json = JSON.parse(res.body);
    const rows = json.rows || [];
    const byUen = Object.fromEntries(rows.map(r => [r.uen, r.has_auditor]));
    const truthy = v => v === 1 || v === true || v === '1';
    check('SELECT has_auditor is true for a real firm', truthy(byUen.A1), `got ${byUen.A1}`);
    check("SELECT has_auditor is false for 'na'", !truthy(byUen.A2), `got ${byUen.A2}`);
    check('SELECT has_auditor is false for empty string', !truthy(byUen.A3), `got ${byUen.A3}`);
    check('SELECT has_auditor is false for NULL', !truthy(byUen.A4), `got ${byUen.A4}`);

    // 6. The two filters partition the table: no row lost, none double-counted.
    check('true (2) + false (3) accounts for every row', rows.length === 5, `total ${rows.length}`);
  } finally {
    mock.restore();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main();
