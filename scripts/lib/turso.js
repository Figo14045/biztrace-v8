// ══════════════════════════════════════════════════════════════════════════
// Shared Turso client for the offline scripts.
//
// Deliberately the same HTTP pipeline shape that netlify/functions/query.js
// and enrich-save.js already use in production, so there is one wire format
// to reason about rather than two. Zero dependencies — Node 18+ has fetch.
//
// TOKEN SEPARATION: the project keeps a read-only token (TURSO_AUTH_TOKEN,
// used by query.js) apart from a read-write token (TURSO_WRITE_TOKEN, used
// only by enrich-save.js). That separation is preserved here: every caller
// must say which one it wants, and read-only is the default.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────────────────────────────────
// .env loading
// ──────────────────────────────────────────────────────────────────────────
// Netlify reads its env vars at deploy time; these scripts run on your
// machine, so they need the same values locally. Looks for a .env at the
// repo root. Real environment variables always win, so CI or a shell export
// can override the file.

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
let envFileFound = false;
let envFileNote = '';

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  envFileFound = true;

  const raw = fs.readFileSync(ENV_PATH);

  // Windows trap: PowerShell 5.1's Set-Content and Out-File default to
  // UTF-16LE. The file looks perfectly normal in an editor but every byte of
  // ASCII is followed by a null, so nothing parses and every key comes back
  // missing — a genuinely baffling symptom worth naming explicitly.
  if (raw.length >= 2 &&
      ((raw[0] === 0xFF && raw[1] === 0xFE) || (raw[0] === 0xFE && raw[1] === 0xFF))) {
    envFileNote = 'The file is UTF-16 encoded. Re-save it as UTF-8 — in PowerShell, ' +
                  'use  Set-Content -Encoding utf8  (or just edit it in Notepad and save).';
    return;
  }

  // Strip a UTF-8 BOM if present; otherwise the first key parses as
  // "﻿TURSO_URL" and silently never matches.
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one layer of matching quotes, if present.
    if (value.length >= 2 &&
        ((value[0] === '"' && value.at(-1) === '"') ||
         (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

// ──────────────────────────────────────────────────────────────────────────
// Connection
// ──────────────────────────────────────────────────────────────────────────

// Build an error that says what is actually wrong, rather than just naming
// the missing variable. Nearly every failure here is "the .env is not where
// or what you think it is", so the message reports what was found on disk.
function missingVarError(name) {
  const lines = [`${name} is not set.`, ''];

  if (!envFileFound) {
    lines.push(`No .env file was found at:`, `  ${ENV_PATH}`, '');

    const siblings = (() => {
      try {
        return fs.readdirSync(path.dirname(ENV_PATH))
          .filter(f => f.toLowerCase().startsWith('.env'));
      } catch { return []; }
    })();

    if (siblings.length) {
      lines.push(`That directory does contain: ${siblings.join(', ')}`);
      if (siblings.some(f => f.toLowerCase() !== '.env.example' && f !== '.env')) {
        lines.push('If one of those is meant to be your .env, rename it — Windows editors');
        lines.push('often append .txt without showing it.');
      } else {
        lines.push('Create the real one:  copy .env.example .env   then fill in the values.');
      }
    }
  } else if (envFileNote) {
    lines.push(`.env was found at ${ENV_PATH} but could not be read.`, envFileNote);
  } else {
    lines.push(`.env was found and parsed, but it has no ${name}= line.`,
               `Check for a typo in the key name, and that the value is not left blank.`);
  }

  return new Error(lines.join('\n'));
}

function httpBase() {
  const url = process.env.TURSO_URL;
  if (!url) throw missingVarError('TURSO_URL');
  return url.replace(/^libsql:\/\//, 'https://');
}

function tokenFor(mode) {
  if (mode === 'write') {
    const t = process.env.TURSO_WRITE_TOKEN;
    if (!t) {
      const err = missingVarError('TURSO_WRITE_TOKEN');
      err.message += '\n\nThis script needs the read-WRITE token, not the ' +
                     'read-only TURSO_AUTH_TOKEN used by query.js.';
      throw err;
    }
    return t;
  }

  const t = process.env.TURSO_AUTH_TOKEN;
  if (!t) throw missingVarError('TURSO_AUTH_TOKEN');
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// Value encoding — matches query.js exactly
// ──────────────────────────────────────────────────────────────────────────

function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return { type: 'float', value: v };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  return { type: 'text', value: String(v) };
}

// ──────────────────────────────────────────────────────────────────────────
// execute — run statements in one pipeline round-trip
// ──────────────────────────────────────────────────────────────────────────
// statements: [{ sql, args }]
// opts.mode:  'read' (default) | 'write'
//
// Returns an array of results, one per statement, in order.
//
// Errors carry the statement index, because a pipeline that fails on
// statement 7 of 12 is otherwise very hard to diagnose.

async function execute(statements, opts = {}) {
  const mode = opts.mode === 'write' ? 'write' : 'read';
  const base = httpBase();
  const token = tokenFor(mode);

  const requests = statements.map(s => ({
    type: 'execute',
    stmt: { sql: s.sql, args: (s.args || []).map(encodeArg) }
  }));
  requests.push({ type: 'close' });

  const resp = await fetch(`${base}/v3/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
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
      const msg = r.error?.message || JSON.stringify(r.error);
      const err = new Error(`Turso SQL error (statement ${i}): ${msg}`);
      err.statementIndex = i;
      err.sqlMessage = msg;
      throw err;
    }
    out.push(r.response?.result);
  }

  return out;
}

// Convenience: run one statement, get its result.
async function one(sql, args = [], opts = {}) {
  const [result] = await execute([{ sql, args }], opts);
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Row reshaping — Turso returns columns and rows separately
// ──────────────────────────────────────────────────────────────────────────

function rows(result) {
  if (!result) return [];
  const cols = (result.cols || []).map(c => c.name);
  return (result.rows || []).map(r => {
    const obj = {};
    r.forEach((cell, i) => {
      obj[cols[i]] = (cell && typeof cell === 'object')
        ? (cell.type === 'null' ? null : cell.value)
        : cell;
    });
    return obj;
  });
}

module.exports = { execute, one, rows, httpBase };
