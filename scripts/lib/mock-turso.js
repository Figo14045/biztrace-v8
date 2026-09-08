// In-process mock of the Turso HTTP API, for testing the Netlify functions
// offline without pointing anything at the production database.
//
// It replaces global.fetch and answers /v3/pipeline requests out of an
// in-memory SQLite database, using node:sqlite — built into Node, so there is
// nothing to install and no Python, no sqlite3 CLI, no server process and no
// port to collide with. (An earlier version of this used a Python HTTP server;
// it was useless on a machine without Python, which is every machine on this
// team.)
//
// It also records every statement sent, because for some bugs the generated
// SQL is the evidence, not the rows that come back — see the warning below.
//
// Usage:
//   const mock = require('./lib/mock-turso.js').install(schemaSql);
//   ...call the handler...
//   mock.sentSql          // every SQL string sent, in order
//   mock.restore()        // put the real fetch back
//
// ─────────────────────────────────────────────────────────────────────────
// ON DOUBLE-QUOTED IDENTIFIERS — why sentSql exists.
//
// SQLite has a legacy misfeature in which a double-quoted token that doesn't
// resolve to a column is silently reinterpreted as a string literal, so
// `WHERE "has_auditor" = ?` quietly matches nothing instead of failing.
// Whether it bites depends on how the SQLite in use was built: Python 3.11's
// bundled 3.45 has it ON, and the has_auditor bug looked there like a merely
// empty result set. node:sqlite's build has it OFF for DML and reproduces
// Turso's error verbatim:
//   no such column: "has_auditor" - should this be a string literal in
//   single-quotes?
//
// So this mock currently agrees with production — but that agreement is a
// property of the bundled SQLite, not something we control, and it can change
// under us when Node updates. A test that cares about column resolution should
// assert on the SQL in sentSql as well as on the rows returned; only the
// former is guaranteed to keep failing if the flag ever flips back.
// ─────────────────────────────────────────────────────────────────────────

const { DatabaseSync } = require('node:sqlite');

// Turso's wire format tags every value with its type.
function toValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { type: 'integer', value: String(v) }
      : { type: 'float', value: v };
  }
  if (v instanceof Uint8Array) return { type: 'blob', base64: '' };
  return { type: 'text', value: String(v) };
}

function fromArg(a) {
  if (!a || a.type === 'null') return null;
  if (a.type === 'integer') return Number(a.value);
  if (a.type === 'float') return Number(a.value);
  return a.value;
}

function install(schemaSql) {
  const db = new DatabaseSync(':memory:');
  if (schemaSql) db.exec(schemaSql);

  const sentSql = [];
  const realFetch = global.fetch;

  global.fetch = async function (url, opts = {}) {
    let body;
    try { body = JSON.parse(opts.body || '{}'); }
    catch (_) { return realFetch(url, opts); }
    if (!Array.isArray(body.requests)) return realFetch(url, opts);

    const results = [];
    for (const req of body.requests) {
      if (req.type !== 'execute') {
        results.push({ type: 'ok', response: { type: req.type } });
        continue;
      }
      const sql = req.stmt.sql;
      const args = (req.stmt.args || []).map(fromArg);
      sentSql.push(sql);
      try {
        const stmt = db.prepare(sql);
        // node:sqlite throws on .all() for a statement that returns nothing,
        // so writes go through .run() instead.
        let rows = [], cols = [];
        if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)/i.test(sql)) {
          const out = stmt.all(...args);
          rows = out;
          cols = out.length ? Object.keys(out[0]) : [];
        } else {
          stmt.run(...args);
        }
        results.push({
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: cols.map(c => ({ name: c, decltype: null })),
              rows: rows.map(r => cols.map(c => toValue(r[c]))),
              affected_row_count: 0,
              last_insert_rowid: null,
            }
          }
        });
      } catch (e) {
        // Turso reports statement errors in the body with a 200, which is what
        // query.js's error handling is written against.
        results.push({ type: 'error', error: { message: e.message, code: 'SQLITE_ERROR' } });
      }
    }

    const payload = JSON.stringify({ baton: null, base_url: null, results });
    return {
      ok: true,
      status: 200,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  };

  return {
    db,
    sentSql,
    restore() { global.fetch = realFetch; db.close(); },
    // The WHERE clause of the most recent statement, for asserting on the SQL.
    lastWhere() {
      const sql = sentSql[sentSql.length - 1] || '';
      const m = sql.match(/\bWHERE\b([\s\S]*?)(\bORDER\s+BY\b|\bLIMIT\b|\bGROUP\s+BY\b|$)/i);
      return m ? m[1] : '';
    },
  };
}

module.exports = { install };
