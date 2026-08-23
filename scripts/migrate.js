#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// Run a .sql migration file against Turso.
//
//   node scripts/migrate.js migrations/001_stage3_change_tracking.sql
//        → DRY RUN. Prints every statement it would execute. Changes nothing.
//
//   node scripts/migrate.js migrations/001_stage3_change_tracking.sql --apply
//        → Actually runs them, one at a time, using TURSO_WRITE_TOKEN.
//
// Dry run is the default on purpose. This points at the production database.
//
// Statements run ONE AT A TIME rather than as a single pipeline, so a failure
// tells you exactly which statement broke instead of failing the whole batch
// anonymously. Migrations are small; the extra round-trips cost nothing.
//
// Re-runnable: "already exists" and "duplicate column name" are reported as
// SKIPPED rather than treated as failures, because ALTER TABLE ADD COLUMN has
// no IF NOT EXISTS form in SQLite.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { execute } = require('./lib/turso');

// ──────────────────────────────────────────────────────────────────────────
// SQL splitting
// ──────────────────────────────────────────────────────────────────────────
// Naive split(';') breaks on any semicolon inside a string literal or a
// comment. This walks the text tracking whether we are inside a '...' string,
// a -- line comment, or a /* */ block comment, and only treats a semicolon at
// the top level as a statement boundary.

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; current += ch; }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }

    if (inString) {
      current += ch;
      if (ch === "'") {
        // '' is an escaped quote inside a SQLite string, not a terminator.
        if (next === "'") { current += next; i++; }
        else inString = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }

    if (ch === "'") { inString = true; current += ch; continue; }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements;
}

// A one-line label for the console, so the output is scannable.
function describe(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 110 ? flat.slice(0, 107) + '...' : flat;
}

const ALREADY_APPLIED = [
  'already exists',
  'duplicate column name',
];

function isAlreadyApplied(message) {
  const m = String(message || '').toLowerCase();
  return ALREADY_APPLIED.some(s => m.includes(s));
}

// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = args.find(a => !a.startsWith('--'));

  if (!file) {
    console.error('Usage: node scripts/migrate.js <file.sql> [--apply]');
    process.exit(1);
  }

  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`Migration file not found: ${abs}`);
    process.exit(1);
  }

  const statements = splitStatements(fs.readFileSync(abs, 'utf8'));

  console.log('');
  console.log(`Migration : ${path.basename(abs)}`);
  console.log(`Statements: ${statements.length}`);
  console.log(`Mode      : ${apply ? 'APPLY (writes to the database)' : 'DRY RUN (nothing is written)'}`);
  console.log('');

  if (!apply) {
    statements.forEach((s, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${describe(s)}`);
    });
    console.log('');
    console.log('Nothing was written. Re-run with --apply to execute.');
    return;
  }

  let ran = 0, skipped = 0;

  for (let i = 0; i < statements.length; i++) {
    const label = `  ${String(i + 1).padStart(2)}/${statements.length}`;
    process.stdout.write(`${label} ${describe(statements[i])}\n`);

    try {
      const [result] = await execute([{ sql: statements[i] }], { mode: 'write' });
      ran++;

      // Report rows affected for statements that change data. This is the
      // only confirmation that a repair migration did what it claimed — 002
      // is meaningless without it, since "ok" looks identical whether it
      // fixed 164,477 rows or none. DDL reports 0 and stays quiet.
      const affected = Number(result?.affected_row_count ?? 0);
      console.log(affected > 0
        ? `       ok — ${affected.toLocaleString('en-US')} rows affected`
        : '       ok');
    } catch (err) {
      if (isAlreadyApplied(err.sqlMessage || err.message)) {
        skipped++;
        // Deliberately not phrased as "already applied". SQLite matches these
        // on the object NAME, so all this proves is that something with that
        // name exists — not that its definition matches what the migration
        // asked for. Migration 004 was skipped this way by a same-named but
        // NON-unique index and reported success while changing nothing.
        console.log('       skipped — an object with that name already exists');
        console.log('                (this does NOT verify its definition matches;');
        console.log('                 confirm with  node scripts/db-status.js)');
        continue;
      }
      console.log('       FAILED');
      console.log('');
      console.error(err.message);
      console.error('');
      console.error(`Stopped at statement ${i + 1}. Statements 1-${i} were applied.`);
      console.error('This migration is re-runnable — fix the cause and run it again.');
      process.exitCode = 1;
      return;
    }
  }

  console.log('');
  console.log(`Done. ${ran} applied, ${skipped} skipped (already present).`);
}

// Set exitCode rather than calling process.exit(). On Windows, exiting while
// the HTTP client still has sockets closing trips an assertion inside libuv
// (`!(handle->flags & UV_HANDLE_CLOSING)`), which buries the real error under
// a crash dump. Letting Node unwind on its own avoids it.
main().catch(err => {
  console.error('');
  console.error(err.message);
  process.exitCode = 1;
});
