// BizTrace V8 — Turso Proxy
//
// Receives structured query requests from the BizTrace frontend, builds
// parameterised SQL, executes against Turso, returns clean JSON.
//
// CHUNK 2: structured query support
//   - POST { filters, sort, limit, offset, include_count } → rows + total
//   - Parameterised SQL (no string concat with user input)
//   - Column allowlist (prevents arbitrary column access)
//   - SQLite dialect (ILIKE → LIKE COLLATE NOCASE)

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

// ──────────────────────────────────────────────────────────────────────────
// SCHEMA: allowlist of columns BizTrace is permitted to query.
// Derived from the schema you sent. Any field not in this list is rejected.
// ──────────────────────────────────────────────────────────────────────────
const ALLOWED_COLUMNS = new Set([
  'uen', 'issuance_agency_id', 'entity_name', 'entity_type_description',
  'business_constitution_description', 'company_type_description',
  'paf_constitution_description', 'entity_status_description',
  'registration_incorporation_date', 'uen_issue_date',
  'address_type', 'block', 'street_name', 'level_no', 'unit_no',
  'building_name', 'postal_code', 'other_address_line1', 'other_address_line2',
  'account_due_date', 'annual_return_date',
  'primary_ssic_code', 'primary_ssic_description', 'primary_user_described_activity',
  'secondary_ssic_code', 'secondary_ssic_description', 'secondary_user_described_activity',
  'no_of_officers',
  'former_entity_name1', 'former_entity_name2', 'former_entity_name3',
  'former_entity_name4', 'former_entity_name5', 'former_entity_name6',
  'former_entity_name7', 'former_entity_name8', 'former_entity_name9',
  'former_entity_name10', 'former_entity_name11', 'former_entity_name12',
  'former_entity_name13', 'former_entity_name14', 'former_entity_name15',
  'uen_of_audit_firm1', 'name_of_audit_firm1', 'uen_of_audit_firm2',
  'name_of_audit_firm2', 'uen_of_audit_firm3', 'name_of_audit_firm3',
  'uen_of_audit_firm4', 'name_of_audit_firm4', 'uen_of_audit_firm5',
  'name_of_audit_firm5', 'source_file',
  // Derived columns BizTrace expects but don't exist in Turso —
  // we compute them on-the-fly via SELECT expressions (see SELECT_EXPR below)
  'has_auditor', 'full_address',
]);

// SELECT expression for each "virtual" column we need to compute.
// For real columns, we just use the column name directly. For derived ones,
// we emit a computed expression with an alias.
const SELECT_EXPR = {
  'has_auditor':  `(uen_of_audit_firm1 IS NOT NULL AND uen_of_audit_firm1 != '') AS has_auditor`,
  'full_address': `TRIM(COALESCE(block || ' ', '') || COALESCE(street_name, '') || ' ' || COALESCE('#' || level_no || '-' || unit_no, '') || COALESCE(' ' || building_name, '') || COALESCE(' SINGAPORE ' || postal_code, '')) AS full_address`,
};

// Quote a column name safely. Since we've allowlisted via ALLOWED_COLUMNS
// already, all columns are known-safe snake_case identifiers — but we still
// wrap in double-quotes for clarity and to handle any future reserved words.
function quoteCol(col) {
  return `"${col}"`;
}

// Build the SELECT clause. If the request specifies fields, emit just those
// (mixing real columns and computed expressions). Otherwise SELECT *.
function buildSelect(fields) {
  if (!fields || !fields.length) return '*';
  const parts = fields.map(f => {
    if (!ALLOWED_COLUMNS.has(f)) throw new Error(`Unknown column: ${f}`);
    return SELECT_EXPR[f] || quoteCol(f);
  });
  return parts.join(', ');
}

// Build the WHERE clause from a filters array.
// Returns { sql, args } where sql is a string fragment (no leading WHERE)
// and args is an array of bind values.
//
// Supported ops:
//   eq, neq, gt, gte, lt, lte    — value : scalar
//   ilike                        — value : substring (case-insensitive)
//   in                           — values : array
//   is_null, is_not_null         — no value
//   contains_word                — value : matched as whole word (basic)
function buildWhere(filters) {
  if (!filters || !filters.length) return { sql: '', args: [] };
  const clauses = [];
  const args = [];

  for (const f of filters) {
    if (!f || !f.field || !f.op) continue;
    if (!ALLOWED_COLUMNS.has(f.field)) {
      throw new Error(`Unknown filter column: ${f.field}`);
    }
    const col = quoteCol(f.field);

    switch (f.op) {
      case 'eq':
        clauses.push(`${col} = ?`); args.push(f.value); break;
      case 'neq':
        clauses.push(`${col} != ?`); args.push(f.value); break;
      case 'gt':
        clauses.push(`${col} > ?`); args.push(f.value); break;
      case 'gte':
        clauses.push(`${col} >= ?`); args.push(f.value); break;
      case 'lt':
        clauses.push(`${col} < ?`); args.push(f.value); break;
      case 'lte':
        clauses.push(`${col} <= ?`); args.push(f.value); break;
      case 'ilike': {
        // SQLite case-insensitive substring match
        clauses.push(`${col} LIKE ? COLLATE NOCASE`);
        args.push(`%${f.value}%`);
        break;
      }
      case 'starts_with': {
        clauses.push(`${col} LIKE ? COLLATE NOCASE`);
        args.push(`${f.value}%`);
        break;
      }
      case 'in': {
        if (!Array.isArray(f.values) || !f.values.length) {
          // Empty IN list — emit always-false to be explicit
          clauses.push('0 = 1');
          break;
        }
        const placeholders = f.values.map(() => '?').join(',');
        clauses.push(`${col} IN (${placeholders})`);
        for (const v of f.values) args.push(v);
        break;
      }
      case 'is_null':
        clauses.push(`(${col} IS NULL OR ${col} = '')`); break;
      case 'is_not_null':
        clauses.push(`(${col} IS NOT NULL AND ${col} != '')`); break;
      default:
        throw new Error(`Unsupported op: ${f.op}`);
    }
  }

  return { sql: clauses.join(' AND '), args };
}

// Build the ORDER BY clause.
function buildOrderBy(sort) {
  if (!sort || !sort.length) return '';
  const parts = sort.map(s => {
    if (!ALLOWED_COLUMNS.has(s.field)) throw new Error(`Unknown sort column: ${s.field}`);
    const dir = (s.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    // SQLite NULLS LAST equivalent: standard SQL works in modern SQLite
    return `${quoteCol(s.field)} ${dir} NULLS LAST`;
  });
  return parts.join(', ');
}

// ──────────────────────────────────────────────────────────────────────────
// Turso HTTP API client
// ──────────────────────────────────────────────────────────────────────────

function tursoHttpUrl() {
  if (!TURSO_URL) return null;
  return TURSO_URL.replace(/^libsql:\/\//, 'https://');
}

// Run one or more SQL statements in a single pipeline request.
// Each statement is { sql: '...', args: [...] }.
// Returns an array of results, one per statement.
async function executePipeline(statements) {
  const base = tursoHttpUrl();
  if (!base) throw new Error('TURSO_URL env var not set');
  if (!TURSO_AUTH_TOKEN) throw new Error('TURSO_AUTH_TOKEN env var not set');

  const requests = statements.map(s => ({
    type: 'execute',
    stmt: {
      sql: s.sql,
      args: (s.args || []).map(v => {
        if (v === null || v === undefined) return { type: 'null' };
        if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
        if (typeof v === 'number') return { type: 'float', value: v };
        if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
        return { type: 'text', value: String(v) };
      })
    }
  }));
  requests.push({ type: 'close' });

  const resp = await fetch(`${base}/v3/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Turso HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  const json = await resp.json();
  const out = [];
  for (let i = 0; i < statements.length; i++) {
    const r = json.results?.[i];
    if (!r) throw new Error(`No result for statement ${i}`);
    if (r.type === 'error') {
      throw new Error(`Turso SQL error (stmt ${i}): ${r.error?.message || JSON.stringify(r.error)}`);
    }
    out.push(r.response?.result);
  }
  return out;
}

// Reshape Turso's column-first response into array of objects.
// Cells are { type, value } — we strip wrappers, convert integers (which
// arrive as strings to preserve precision), and convert NULL to null.
function reshapeRows(result) {
  if (!result) return [];
  const cols = (result.cols || []).map(c => c.name);
  return (result.rows || []).map(row => {
    const obj = {};
    row.forEach((cell, i) => {
      if (!cell || cell.type === 'null') {
        obj[cols[i]] = null;
      } else if (cell.type === 'integer') {
        // Turso sends integers as strings — convert to number if safe
        const n = Number(cell.value);
        obj[cols[i]] = Number.isSafeInteger(n) ? n : cell.value;
      } else if (cell.type === 'float') {
        obj[cols[i]] = typeof cell.value === 'number' ? cell.value : Number(cell.value);
      } else {
        obj[cols[i]] = cell.value;
      }
    });
    return obj;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Main query builder
// ──────────────────────────────────────────────────────────────────────────

async function runQuery(req) {
  const fields = req.fields || null;     // array of column names, or null for *
  const filters = req.filters || [];
  const sort = req.sort || [];
  const limit = Math.min(Math.max(parseInt(req.limit) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.offset) || 0, 0);
  const includeCount = !!req.include_count;
  const table = 'companies';

  const selectClause = buildSelect(fields);
  const { sql: whereSql, args: whereArgs } = buildWhere(filters);
  const orderClause = buildOrderBy(sort);

  let dataSql = `SELECT ${selectClause} FROM ${table}`;
  if (whereSql) dataSql += ` WHERE ${whereSql}`;
  if (orderClause) dataSql += ` ORDER BY ${orderClause}`;
  dataSql += ` LIMIT ${limit} OFFSET ${offset}`;

  const statements = [{ sql: dataSql, args: whereArgs }];

  if (includeCount) {
    let countSql = `SELECT COUNT(*) AS total FROM ${table}`;
    if (whereSql) countSql += ` WHERE ${whereSql}`;
    statements.push({ sql: countSql, args: whereArgs });
  }

  const results = await executePipeline(statements);
  const rows = reshapeRows(results[0]);
  let total = null;
  if (includeCount && results[1]) {
    const cntRows = reshapeRows(results[1]);
    total = cntRows[0]?.total ?? null;
  }

  return { rows, total, sql: dataSql };  // include sql for debugging during chunk 2
}

// ──────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // Smoke test endpoint (kept from Chunk 1)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params.test === '1') {
      try {
        const results = await executePipeline([
          { sql: 'SELECT COUNT(*) AS total FROM companies', args: [] }
        ]);
        const rows = reshapeRows(results[0]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          ok: true,
          message: 'Smoke test passed',
          turso_url_configured: !!TURSO_URL,
          turso_token_configured: !!TURSO_AUTH_TOKEN,
          result: rows
        })};
      } catch (e) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message })};
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      message: 'BizTrace V8 Turso proxy is alive',
      usage: 'POST with { filters, sort, limit, offset, include_count } — or GET ?test=1'
    })};
  }

  if (event.httpMethod === 'POST') {
    let req;
    try {
      req = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' })};
    }

    try {
      const result = await runQuery(req);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ok: true,
        rows: result.rows,
        total: result.total,
        count: result.rows.length,
        sql: result.sql  // debug — remove in a later chunk
      })};
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({
        ok: false,
        error: e.message
      })};
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' })};
};