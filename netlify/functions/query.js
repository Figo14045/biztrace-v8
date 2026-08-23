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
  // Stage 3 change tracking. Denormalised onto companies so a badge can be
  // rendered without joining a changelog across 2M rows. change_status holds
  // the highest-priority change for change_month; the full per-field list
  // lives in company_changes.
  'change_status', 'change_month',
  // Derived columns BizTrace expects but don't exist in Turso —
  // we compute them on-the-fly via SELECT expressions (see SELECT_EXPR below)
  'has_auditor', 'full_address',
]);

// ──────────────────────────────────────────────────────────────────────────
// Enrichment join
// ──────────────────────────────────────────────────────────────────────────
// Enrichment results live in a separate `enrichments` table so the 2M-row
// authoritative ACRA data is never mixed with derived, uncertain data (and so
// a monthly ACRA refresh can't wipe it).
//
// `uen` is the ONLY column name shared by both tables, so it is the only one
// needing qualification when we join. Everything else — including the computed
// SELECT expressions — stays unambiguous.
const COMPANIES_ALIAS = 'c';
const ENRICH_ALIAS = 'e';

const ENRICHMENT_FIELDS = [
  'website', 'email', 'phone', 'linkedin', 'description',
  'identity_confidence', 'contact_confidence',
  'email_source_url', 'phone_source_url',
  'email_source', 'email_verdict', 'email_domain_match',
  'engine', 'model_used', 'outcome',
  'approval', 'approved_at',
  'enriched_at', 'first_enriched_at', 'enrichment_count',
];

// Prefix each enrichment column so it can't collide with a company column and
// so the frontend can tell where a value came from.
function buildEnrichmentSelect() {
  return ENRICHMENT_FIELDS
    .map(f => `${ENRICH_ALIAS}."${f}" AS enr_${f}`)
    .join(', ');
}

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
function quoteCol(col, qualify) {
  // Only `uen` exists in both companies and enrichments, so it is the only
  // column that must be table-qualified when the enrichment join is active.
  if (qualify && col === 'uen') return `${COMPANIES_ALIAS}."${col}"`;
  return `"${col}"`;
}

// Build the SELECT clause. If the request specifies fields, emit just those
// (mixing real columns and computed expressions). Otherwise SELECT *.
function buildSelect(fields, qualify) {
  if (!fields || !fields.length) return qualify ? `${COMPANIES_ALIAS}.*` : '*';
  const parts = fields.map(f => {
    if (!ALLOWED_COLUMNS.has(f)) throw new Error(`Unknown column: ${f}`);
    return SELECT_EXPR[f] || quoteCol(f, qualify);
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
function buildWhere(filters, qualify) {
  if (!filters || !filters.length) return { sql: '', args: [] };
  const clauses = [];
  const args = [];

  for (const f of filters) {
    if (!f || !f.field || !f.op) continue;
    if (!ALLOWED_COLUMNS.has(f.field)) {
      throw new Error(`Unknown filter column: ${f.field}`);
    }
    const col = quoteCol(f.field, qualify);

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

// Build a WHERE clause for a list of sub-filters joined by OR.
// Used for things like SSIC search where we want
// "(primary_ssic_code matches X) OR (primary_ssic_description matches X)".
// Each sub-filter has the same structure as a regular filter.
function buildOrGroup(subFilters, qualify) {
  if (!subFilters || !subFilters.length) return { sql: '', args: [] };
  const tmp = buildWhere(subFilters, qualify);
  if (!tmp.sql) return { sql: '', args: [] };
  // buildWhere joined them with AND; we need them joined with OR instead.
  // We rebuild by running each one individually then re-joining.
  const clauses = [];
  const args = [];
  for (const f of subFilters) {
    const one = buildWhere([f], qualify);
    if (one.sql) {
      clauses.push(`(${one.sql})`);
      for (const a of one.args) args.push(a);
    }
  }
  return { sql: clauses.length ? '(' + clauses.join(' OR ') + ')' : '', args };
}

// Build the ORDER BY clause.
function buildOrderBy(sort, qualify) {
  if (!sort || !sort.length) return '';
  const parts = sort.map(s => {
    if (!ALLOWED_COLUMNS.has(s.field)) throw new Error(`Unknown sort column: ${s.field}`);
    const dir = (s.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    // SQLite NULLS LAST equivalent: standard SQL works in modern SQLite
    return `${quoteCol(s.field, qualify)} ${dir} NULLS LAST`;
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
// Density query (Chunk 3): server-side GROUP BY for Virtual Office detection.
// Returns only (postal_code, level_no, unit_no, count) tuples with count >= 5.
// This avoids streaming 2M rows over the wire just to compute densities.
// ──────────────────────────────────────────────────────────────────────────
async function runDensity(req) {
  const minCount = Math.max(parseInt(req.min_count) || 5, 1);

  const sql = `
    SELECT postal_code, level_no, unit_no, COUNT(*) AS company_count
    FROM companies
    WHERE postal_code IS NOT NULL AND postal_code != '' AND postal_code != 'na'
      AND entity_status_description IN ('Live', 'Live Company', 'Live (Receiver or Receiver and Manager appointed)')
    GROUP BY postal_code, level_no, unit_no
    HAVING COUNT(*) >= ?
    ORDER BY company_count DESC
  `;

  const results = await executePipeline([{ sql, args: [minCount] }]);
  const rows = reshapeRows(results[0]);
  return { rows };
}

// ──────────────────────────────────────────────────────────────────────────
// Distinct values (Chunk 3): one column at a time.
// Returns distinct non-null values of one column. Used for filter dropdowns.
// ──────────────────────────────────────────────────────────────────────────
async function runDistinct(req) {
  const field = req.field;
  if (!field || !ALLOWED_COLUMNS.has(field)) {
    throw new Error(`Unknown distinct column: ${field}`);
  }
  const limit = Math.min(Math.max(parseInt(req.limit) || 500, 1), 2000);
  const col = quoteCol(field);
  const sql = `SELECT DISTINCT ${col} AS value FROM companies WHERE ${col} IS NOT NULL AND ${col} != '' AND ${col} != 'na' ORDER BY ${col} LIMIT ${limit}`;
  const results = await executePipeline([{ sql, args: [] }]);
  const rows = reshapeRows(results[0]);
  return { values: rows.map(r => r.value) };
}

// ──────────────────────────────────────────────────────────────────────────
// Main query builder
// ──────────────────────────────────────────────────────────────────────────

async function runQuery(req) {
  const fields = req.fields || null;     // array of column names, or null for *
  const filters = req.filters || [];
  const orGroups = req.or_groups || [];  // each item is an array of sub-filters joined by OR
  const sort = req.sort || [];
  const limit = Math.min(Math.max(parseInt(req.limit) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.offset) || 0, 0);
  const includeCount = !!req.include_count;
  const table = 'companies';

  // Enrichment join. When on, every returned row carries its saved enrichment
  // (if any) as enr_* fields, so previously-enriched companies show their
  // contacts immediately on page load without paying for another lookup.
  const includeEnrichment = !!req.include_enrichment;

  // 'all' | 'enriched' | 'not_enriched'
  // "Enriched" deliberately means ANY saved row exists, regardless of approval
  // state — otherwise an unreviewed company would look un-enriched and someone
  // would pay to look it up again.
  const enrichedFilter = ['enriched', 'not_enriched'].includes(req.enriched_filter)
    ? req.enriched_filter : 'all';

  // Approval state filter, used by the review queue to fetch every pending
  // record across all sessions and users — not just whatever is on screen.
  const approvalFilter = ['approved', 'pending', 'rejected', 'none'].includes(req.approval_filter)
    ? req.approval_filter : 'any';

  // Stage 3 change filter. 'any' (off), 'changed' (anything that changed in
  // the current release), or one specific change type.
  //
  // The vocabulary is owned by scripts/lib/acra.js, which is the only writer
  // to these columns. Listed here rather than imported because Netlify
  // functions bundle independently of the offline scripts.
  const CHANGE_TYPES = ['NEW_REGISTERED', 'STRUCK_OFF', 'GAZETTED',
                        'REVIVED', 'STATUS_CHANGED', 'ADDRESS_CHANGED'];
  const changeFilter = (req.change_filter === 'changed' ||
                        CHANGE_TYPES.includes(req.change_filter))
    ? req.change_filter : 'any';

  // The join is required whenever we return enrichment data OR filter on it.
  const useJoin = includeEnrichment || enrichedFilter !== 'all' || approvalFilter !== 'any';

  let selectClause = buildSelect(fields, useJoin);
  if (includeEnrichment) selectClause += ', ' + buildEnrichmentSelect();

  const wherePieces = [];
  const whereArgs = [];

  const baseWhere = buildWhere(filters, useJoin);
  if (baseWhere.sql) {
    wherePieces.push(baseWhere.sql);
    for (const a of baseWhere.args) whereArgs.push(a);
  }
  for (const group of orGroups) {
    const g = buildOrGroup(group, useJoin);
    if (g.sql) {
      wherePieces.push(g.sql);
      for (const a of g.args) whereArgs.push(a);
    }
  }

  // Enrichment presence filter, expressed against the joined table.
  if (enrichedFilter === 'enriched') {
    // No predicate needed — the INNER JOIN above already restricts to rows
    // that have a matching enrichment.
  } else if (enrichedFilter === 'not_enriched') {
    wherePieces.push(`${ENRICH_ALIAS}."uen" IS NULL`);
  }

  if (approvalFilter !== 'any') {
    // Parameterised, and implies the row exists, so no extra NULL check needed.
    wherePieces.push(`${ENRICH_ALIAS}."approval" = ?`);
    whereArgs.push(approvalFilter);
  }

  // Change filter. Always pinned to the CURRENT release, resolved server-side
  // from data_versions rather than taken from the client — a stale browser tab
  // must not be able to filter on last month's badges.
  //
  // (SELECT MAX(month) FROM data_versions) is a constant subquery over a table
  // with one row per monthly release, so SQLite evaluates it once. Combined
  // with change_status IS NOT NULL it matches idx_companies_change, which is
  // PARTIAL — it only carries changed rows, so this reads ~87k index entries
  // rather than scanning 2M companies.
  if (changeFilter !== 'any') {
    wherePieces.push(
      `"change_status" IS NOT NULL AND ` +
      `"change_month" = (SELECT MAX(month) FROM data_versions)`
    );
    if (changeFilter !== 'changed') {
      wherePieces.push(`"change_status" = ?`);
      whereArgs.push(changeFilter);
    }
  }

  const whereSql = wherePieces.join(' AND ');
  const orderClause = buildOrderBy(sort, useJoin);

  // 'enriched' uses an INNER JOIN so the query planner can start from the small
  // enrichments table (hundreds of rows) and look each company up by its uen
  // index. A LEFT JOIN with "e.uen IS NOT NULL" is logically the same but makes
  // SQLite walk all ~2M companies, which blows the function timeout.
  const joinType = (enrichedFilter === 'enriched' || approvalFilter !== 'any')
    ? 'INNER JOIN' : 'LEFT JOIN';

  const fromClause = useJoin
    ? `${table} ${COMPANIES_ALIAS} ${joinType} enrichments ${ENRICH_ALIAS} ` +
      `ON ${COMPANIES_ALIAS}."uen" = ${ENRICH_ALIAS}."uen"`
    : table;

  let dataSql = `SELECT ${selectClause} FROM ${fromClause}`;
  if (whereSql) dataSql += ` WHERE ${whereSql}`;
  if (orderClause) dataSql += ` ORDER BY ${orderClause}`;
  dataSql += ` LIMIT ${limit} OFFSET ${offset}`;

  const statements = [{ sql: dataSql, args: whereArgs }];

  // COUNT(*) optimization: counting is the slowest part of a query. When
  // there is NO filter at all, COUNT(*) would scan all ~2M rows and can blow
  // past the Netlify function timeout. In that case we skip the count query
  // entirely and signal the frontend to use the known table total instead.
  const hasAnyFilter = !!whereSql;

  // Counting "not enriched" rows is the expensive case: it means walking all
  // ~2M companies and probing the join for each, which risks the function
  // timeout. When that is the ONLY filter we avoid it entirely — count the
  // small enrichments table instead and let the frontend subtract from the
  // table total it already knows.
  const otherFilters = filters.length > 0 || orGroups.length > 0 || approvalFilter !== 'any';

  // Counting across the 2M-row companies table is what used to time out, so
  // both enrichment-only cases are answered from the small enrichments table:
  //   enriched      → COUNT(enrichments) IS the answer
  //   not_enriched  → total − COUNT(enrichments), computed by the frontend
  const cheapEnrichedCount =
    includeCount && enrichedFilter === 'enriched' && !otherFilters;
  const cheapNotEnrichedCount =
    includeCount && enrichedFilter === 'not_enriched' && !otherFilters;
  const cheapCount = cheapEnrichedCount || cheapNotEnrichedCount;

  const doCount = includeCount && hasAnyFilter && !cheapCount;

  if (doCount) {
    let countSql = `SELECT COUNT(*) AS total FROM ${fromClause}`;
    countSql += ` WHERE ${whereSql}`;
    statements.push({ sql: countSql, args: whereArgs });
  } else if (cheapCount) {
    statements.push({ sql: `SELECT COUNT(*) AS total FROM enrichments`, args: [] });
  }

  const results = await executePipeline(statements);
  const rows = reshapeRows(results[0]);
  let total = null;
  let unfilteredTotal = false;
  let enrichedTotal = null;

  if (doCount && results[1]) {
    const cntRows = reshapeRows(results[1]);
    total = cntRows[0]?.total ?? null;
  } else if (cheapEnrichedCount && results[1]) {
    // Every enrichment row corresponds to one company, so this is the total.
    const cntRows = reshapeRows(results[1]);
    total = cntRows[0]?.total ?? null;
  } else if (cheapNotEnrichedCount && results[1]) {
    // Hand back the enriched count; the frontend computes
    // (known table total − enriched) to get the not-enriched total.
    const cntRows = reshapeRows(results[1]);
    enrichedTotal = cntRows[0]?.total ?? null;
  } else if (includeCount && !hasAnyFilter && enrichedFilter === 'all' && approvalFilter === 'any') {
    // No filter at all → frontend uses the full-table total it already knows.
    unfilteredTotal = true;
  }

  return {
    rows,
    total,
    unfiltered_total: unfilteredTotal,
    enriched_total: enrichedTotal,   // set only for the cheap not-enriched path
    sql: dataSql
  };
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
      // Mode dispatch: density / distinct / standard query
      if (req.mode === 'density') {
        const result = await runDensity(req);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          ok: true,
          rows: result.rows,
          count: result.rows.length
        })};
      }
      // Which ACRA release is loaded, and how much changed in it. The
      // frontend calls this once at startup: a badge is rendered only when a
      // row's change_month equals the current release, which is how "New
      // Registered" stops showing after a month without a monthly UPDATE
      // across 2M rows.
      //
      // Cheap by construction — data_versions holds one row per release, and
      // the badge breakdown reads the partial index, not the companies table.
      if (req.mode === 'change_summary') {
        const results = await executePipeline([
          { sql: `SELECT month, loaded_at, companies_total, changes_recorded
                    FROM data_versions ORDER BY month DESC LIMIT 12`, args: [] },
          { sql: `SELECT change_status, COUNT(*) AS n
                    FROM companies
                   WHERE change_status IS NOT NULL
                     AND change_month = (SELECT MAX(month) FROM data_versions)
                GROUP BY change_status`, args: [] },
        ]);
        const versions = reshapeRows(results[0]);
        const byType = {};
        for (const r of reshapeRows(results[1])) byType[r.change_status] = Number(r.n);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          ok: true,
          current_month: versions[0]?.month || null,
          previous_month: versions[1]?.month || null,
          versions,
          counts: byType,
        })};
      }

      if (req.mode === 'distinct') {
        const result = await runDistinct(req);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          ok: true,
          values: result.values,
          count: result.values.length
        })};
      }

      const result = await runQuery(req);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ok: true,
        rows: result.rows,
        total: result.total,
        count: result.rows.length,
        // Signals the frontend needs to resolve a count we deliberately did
        // not run. Both must be forwarded or the frontend silently shows 0.
        unfiltered_total: result.unfiltered_total,
        enriched_total: result.enriched_total,
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