// BizTrace V8 — Enrichment write-back
//
// This is the ONLY function in BizTrace that writes to the database. Everything
// else (query.js and the enrichment proxies) is read-only. Keeping the write
// path in one small, tightly-scoped file makes it easy to audit.
//
// SAFETY RULES enforced here:
//   - Only ever touches the `enrichments` table. The 2M-row `companies` table
//     holding authoritative ACRA data is never written to.
//   - Every value is parameterised. No string interpolation into SQL.
//   - Columns are allowlisted; anything unexpected in the payload is dropped.
//
// Two actions:
//   save    — full upsert of an enrichment result (one or many companies)
//   approve — update only the approval state (used by the Suggestion Queue,
//             so reviewing doesn't rewrite the record or inflate the counter)
//
// Request body:
//   { action: 'save',    records: [ { uen, website, email, ... }, ... ] }
//   { action: 'approve', records: [ { uen, approval: 'approved' }, ... ] }
//
// Response:
//   { ok: true, saved: <n> }

const TURSO_URL = process.env.TURSO_URL;

// Prefer a dedicated write token so the read-only token used by query.js stays
// read-only. Falls back to TURSO_AUTH_TOKEN if only one token is configured.
const TURSO_WRITE_TOKEN = process.env.TURSO_WRITE_TOKEN || process.env.TURSO_AUTH_TOKEN;

const TABLE = 'enrichments';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Columns we accept from the client, excluding the ones we manage ourselves
// (uen, the three timestamps, enrichment_count). Anything not listed is ignored.
const WRITABLE_COLUMNS = [
  'website', 'email', 'phone', 'linkedin', 'description',
  'identity_confidence', 'contact_confidence',
  'email_source_url', 'phone_source_url',
  'email_source', 'email_verdict', 'email_domain_match',
  'engine', 'model_used', 'outcome',
  'approval',
];

const VALID_APPROVAL = new Set(['approved', 'pending', 'rejected', 'none']);
const VALID_OUTCOME  = new Set(['FOUND', 'PARTIAL', 'NOT_FOUND']);

function httpBase() {
  if (!TURSO_URL) return null;
  return TURSO_URL.replace(/^libsql:\/\//, 'https://');
}

// Run statements in a single Turso pipeline request (one HTTP round-trip).
async function executePipeline(statements) {
  const base = httpBase();
  if (!base) throw new Error('TURSO_URL env var not set');
  if (!TURSO_WRITE_TOKEN) throw new Error('No write token configured');

  const requests = statements.map(s => ({
    type: 'execute',
    stmt: {
      sql: s.sql,
      args: s.args.map(v => {
        if (v === null || v === undefined) return { type: 'null' };
        if (typeof v === 'number') {
          return Number.isInteger(v)
            ? { type: 'integer', value: String(v) }
            : { type: 'float', value: v };
        }
        return { type: 'text', value: String(v) };
      })
    }
  }));
  requests.push({ type: 'close' });

  const resp = await fetch(`${base}/v3/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_WRITE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Turso ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const json = await resp.json();
  // Surface the first statement-level error rather than silently succeeding.
  for (const r of (json.results || [])) {
    if (r.type === 'error') {
      throw new Error(`SQL error: ${r.error?.message || 'unknown'}`);
    }
  }
  return json.results || [];
}

// Build the upsert for one enrichment record.
//
// On conflict we refresh the data and bump the counter, but deliberately do NOT
// touch first_enriched_at — that records when we first ever looked this company
// up, which is what tells us later how stale a record has become.
function buildSaveStatement(rec, nowIso) {
  const cols = ['uen'];
  const vals = [rec.uen];

  for (const c of WRITABLE_COLUMNS) {
    if (rec[c] === undefined) continue;
    let v = rec[c];

    // Normalise the constrained fields rather than trusting the client.
    if (c === 'approval' && !VALID_APPROVAL.has(v)) v = 'pending';
    if (c === 'outcome' && v !== null && !VALID_OUTCOME.has(v)) v = null;
    if (c === 'email_domain_match') v = v ? 1 : 0;

    cols.push(c);
    vals.push(v === '' ? null : v);
  }

  // Timestamps are generated server-side in UTC — never taken from the client,
  // whose clock may be wrong or in a different timezone.
  cols.push('enriched_at', 'first_enriched_at', 'enrichment_count');
  vals.push(nowIso, nowIso, 1);

  // approved_at only when this record arrives already approved.
  if (rec.approval === 'approved') {
    cols.push('approved_at');
    vals.push(nowIso);
  }

  const placeholders = cols.map(() => '?').join(', ');

  // Everything except uen / first_enriched_at / enrichment_count gets refreshed.
  const updates = cols
    .filter(c => c !== 'uen' && c !== 'first_enriched_at' && c !== 'enrichment_count')
    .map(c => `${c} = excluded.${c}`);
  updates.push('enrichment_count = enrichment_count + 1');

  const sql = `
    INSERT INTO ${TABLE} (${cols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(uen) DO UPDATE SET
      ${updates.join(',\n      ')}
  `;

  return { sql, args: vals };
}

// Approval-only update. Used by the Suggestion Queue so that reviewing a record
// doesn't rewrite its contact data or inflate enrichment_count.
function buildApproveStatement(rec, nowIso) {
  const approval = VALID_APPROVAL.has(rec.approval) ? rec.approval : 'pending';
  const approvedAt = approval === 'approved' ? nowIso : null;
  return {
    sql: `UPDATE ${TABLE} SET approval = ?, approved_at = ? WHERE uen = ?`,
    args: [approval, approvedAt, rec.uen]
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  if (!TURSO_URL || !TURSO_WRITE_TOKEN) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        error: 'Database write is not configured on the server',
        turso_url_configured: !!TURSO_URL,
        write_token_configured: !!TURSO_WRITE_TOKEN
      })
    };
  }

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const action = req.action === 'approve' ? 'approve' : 'save';
  const records = Array.isArray(req.records) ? req.records : [];

  if (!records.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'No records supplied' }) };
  }

  // Cap the batch so one call can't run past the Netlify function timeout.
  // The frontend chunks larger sets.
  if (records.length > 200) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Too many records in one call (max 200)' }) };
  }

  const valid = records.filter(r => r && typeof r.uen === 'string' && r.uen.trim());
  if (!valid.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'No records with a valid uen' }) };
  }

  const nowIso = new Date().toISOString();

  let statements;
  try {
    statements = valid.map(rec =>
      action === 'approve'
        ? buildApproveStatement(rec, nowIso)
        : buildSaveStatement(rec, nowIso)
    );
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: `Bad record: ${e.message}` }) };
  }

  try {
    await executePipeline(statements);
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, action, saved: valid.length, enriched_at: nowIso })
  };
};
