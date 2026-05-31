// BizTrace V8 — Turso Proxy (Chunk 1: skeleton + smoke test)
//
// This Netlify function sits between the browser and Turso. The browser
// cannot talk to Turso directly because:
//   1. The Turso auth token must stay server-side (read-only or not, it
//      shouldn't be in browser-visible code).
//   2. Turso doesn't have built-in CORS for browser origins.
//
// For Chunk 1, this function ONLY accepts a hardcoded smoke-test query and
// returns the result. Subsequent chunks will accept structured filter/sort
// requests and build parameterized SQL.

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

// Convert libsql:// URL to https:// for the HTTP API
function tursoHttpUrl() {
  if (!TURSO_URL) return null;
  return TURSO_URL.replace(/^libsql:\/\//, 'https://');
}

// Call Turso's HTTP API with a single SQL statement.
// Turso's HTTP API uses Hrana protocol — we use the v3 pipeline endpoint.
async function executeSql(sql, args = []) {
  const base = tursoHttpUrl();
  if (!base) throw new Error('TURSO_URL env var not set');
  if (!TURSO_AUTH_TOKEN) throw new Error('TURSO_AUTH_TOKEN env var not set');

  const body = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql: sql,
          args: args.map(a => ({ type: 'text', value: String(a) }))
        }
      },
      { type: 'close' }
    ]
  };

  const resp = await fetch(`${base}/v3/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Turso HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  const json = await resp.json();
  // results[0] corresponds to our execute statement
  const result = json.results?.[0];
  if (!result) throw new Error('No result returned');
  if (result.type === 'error') {
    throw new Error(`Turso SQL error: ${result.error?.message || JSON.stringify(result.error)}`);
  }

  // result.response.result has { cols: [...], rows: [[...]] }
  const r = result.response?.result;
  if (!r) throw new Error('Malformed Turso response');

  // Reshape column-first → array of objects
  const cols = (r.cols || []).map(c => c.name);
  const rows = (r.rows || []).map(row => {
    const obj = {};
    row.forEach((cell, i) => {
      // Cells are { type: 'text'|'integer'|'null'|'float'|'blob', value: ... }
      obj[cols[i]] = cell && cell.type !== 'null' ? cell.value : null;
    });
    return obj;
  });

  return { rows, cols, affected_row_count: r.affected_row_count || 0 };
}

// ──────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  // CORS preflight
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Chunk 1 smoke test: GET /api/query?test=1 returns row count from companies
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params.test === '1') {
      try {
        const result = await executeSql('SELECT COUNT(*) AS total FROM companies');
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            ok: true,
            message: 'Smoke test passed — Turso connection working',
            turso_url_configured: !!TURSO_URL,
            turso_token_configured: !!TURSO_AUTH_TOKEN,
            result: result.rows,
            timestamp: new Date().toISOString()
          })
        };
      } catch (e) {
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            ok: false,
            error: e.message,
            turso_url_configured: !!TURSO_URL,
            turso_token_configured: !!TURSO_AUTH_TOKEN
          })
        };
      }
    }

    // Default GET response — usage info
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        message: 'BizTrace V8 Turso proxy is alive',
        usage: 'POST a structured query to this endpoint (Chunks 2+) or GET ?test=1 for a smoke test',
        turso_url_configured: !!TURSO_URL,
        turso_token_configured: !!TURSO_AUTH_TOKEN
      })
    };
  }

  // POST handling will be implemented in Chunk 2 onward
  if (event.httpMethod === 'POST') {
    return {
      statusCode: 501,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: 'POST query handling not implemented yet (coming in Chunk 2)'
      })
    };
  }

  return {
    statusCode: 405,
    headers: corsHeaders,
    body: JSON.stringify({ ok: false, error: 'Method not allowed' })
  };
};
