#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// Apply a diff produced by diff-acra.js to Turso.
//
//   node scripts/apply-diff.js --dir data/diff-2026-08              # dry run
//   node scripts/apply-diff.js --dir data/diff-2026-08 --limit 100 --apply
//   node scripts/apply-diff.js --dir data/diff-2026-08 --apply
//
// This is the first thing in the project that writes hundreds of thousands
// of rows to production, so a few things are deliberate:
//
//   DRY RUN BY DEFAULT.  --apply is required to write anything.
//
//   EVERY WRITE IS IDEMPOTENT.  Upserts use ON CONFLICT DO UPDATE, changelog
//   rows use INSERT OR IGNORE against the dedupe index, badges are plain
//   UPDATEs. Re-running after a failure repeats work but never corrupts it,
//   which is what makes resuming safe.
//
//   RESUMABLE.  Progress is checkpointed to .progress.json in the diff
//   directory after every batch. A crash, a dropped connection, or a Ctrl-C
//   resumes from the last completed batch instead of starting over.
//
//   THE MONTH IS STAMPED LAST.  Badges only render for the newest month in
//   data_versions, so until the final statement runs the UI shows exactly
//   what it showed before. A half-finished load is invisible rather than
//   half-visible.
//
// Order matters: upserts → changes → badges. Badges UPDATE companies, so
// newly registered companies have to exist first.
//
// Flags:
//   --dir <path>     diff directory (required)
//   --apply          actually write; without it, nothing is sent
//   --limit <n>      only process the first n rows of each file
//   --batch <n>      statements per pipeline request (default 100)
//   --restart        ignore the checkpoint and start from the beginning
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execute, rows } = require('./lib/turso');
const { ACRA_COLUMNS, CHANGE_TYPES } = require('./lib/acra');

// companies columns the loader writes: the 53 ACRA columns plus source_file.
// change_status and change_month are deliberately NOT here — they are set by
// the badge phase, and an upsert must never clobber them.
const COMPANY_COLUMNS = [...ACRA_COLUMNS, 'source_file'];
const CHANGE_TYPE_SET = new Set(CHANGE_TYPES);

const PHASES = ['upserts', 'changes', 'badges'];

function fmt(n) { return Number(n).toLocaleString('en-US'); }

function parseArgs(argv) {
  const args = { apply: false, limit: 0, batch: 100, restart: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir')          args.dir = argv[++i];
    else if (a === '--apply')   args.apply = true;
    else if (a === '--limit')   args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--batch')   args.batch = parseInt(argv[++i], 10) || 100;
    else if (a === '--restart') args.restart = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return args;
}

// ──────────────────────────────────────────────────────────────────────────
// Statement builders
// ──────────────────────────────────────────────────────────────────────────

const UPSERT_SQL = (() => {
  const cols = COMPANY_COLUMNS.map(c => `"${c}"`).join(', ');
  const placeholders = COMPANY_COLUMNS.map(() => '?').join(', ');
  const updates = COMPANY_COLUMNS
    .filter(c => c !== 'uen')
    .map(c => `"${c}" = excluded."${c}"`)
    .join(', ');
  return `INSERT INTO companies (${cols}) VALUES (${placeholders}) ` +
         `ON CONFLICT("uen") DO UPDATE SET ${updates}`;
})();

function upsertStatement(row) {
  return { sql: UPSERT_SQL, args: COMPANY_COLUMNS.map(c => row[c] ?? 'na') };
}

function changeStatement(row) {
  if (!CHANGE_TYPE_SET.has(row.change_type)) {
    throw new Error(`Unknown change_type "${row.change_type}" for UEN ${row.uen}`);
  }
  return {
    sql: `INSERT OR IGNORE INTO company_changes
            (uen, change_month, change_type, field, old_value, new_value)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [row.uen, row.change_month, row.change_type,
           row.field ?? '', row.old_value, row.new_value],
  };
}

function badgeStatement(row) {
  return {
    sql: `UPDATE companies SET change_status = ?, change_month = ? WHERE uen = ?`,
    args: [row.change_status, row.change_month, row.uen],
  };
}

const BUILDERS = {
  upserts: upsertStatement,
  changes: changeStatement,
  badges:  badgeStatement,
};

// ──────────────────────────────────────────────────────────────────────────
// Checkpointing
// ──────────────────────────────────────────────────────────────────────────

function loadCheckpoint(dir, restart) {
  const file = path.join(dir, '.progress.json');
  if (restart || !fs.existsSync(file)) {
    return { file, done: { upserts: 0, changes: 0, badges: 0 }, stamped: false };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      done: { upserts: 0, changes: 0, badges: 0, ...saved.done },
      stamped: !!saved.stamped,
    };
  } catch {
    return { file, done: { upserts: 0, changes: 0, badges: 0 }, stamped: false };
  }
}

function saveCheckpoint(cp) {
  fs.writeFileSync(cp.file, JSON.stringify({ done: cp.done, stamped: cp.stamped,
                                             updated_at: new Date().toISOString() }, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────
// Preflight
// ──────────────────────────────────────────────────────────────────────────
// ON CONFLICT("uen") needs a UNIQUE or PRIMARY KEY on companies.uen. If it is
// missing, SQLite rejects every upsert with a message that does not obviously
// point at the cause — so check once, up front, and say so plainly.

async function preflight() {
  const [t] = await execute([{
    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='companies'`
  }]);
  const ddl = rows(t)[0]?.sql;
  if (!ddl) throw new Error('Table `companies` not found.');

  const pkInline = /"?uen"?\s+[A-Za-z]+\s+PRIMARY\s+KEY/i.test(ddl);
  const pkClause = /PRIMARY\s+KEY\s*\(\s*"?uen"?\s*\)/i.test(ddl);

  const [ix] = await execute([{
    sql: `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='companies'`
  }]);
  const uniqueIdx = rows(ix).some(i => /CREATE\s+UNIQUE\s+INDEX/i.test(i.sql || '') &&
                                       /\(\s*"?uen"?\s*\)/i.test(i.sql || ''));

  if (!pkInline && !pkClause && !uniqueIdx) {
    throw new Error(
      'companies.uen has no PRIMARY KEY or UNIQUE index.\n\n' +
      'Run migration 004 first:\n\n' +
      '  node scripts/migrate.js migrations/004_companies_uen_unique.sql --apply\n\n' +
      'Two reasons it is required. The upsert uses ON CONFLICT("uen"), which\n' +
      'SQLite can only resolve against a unique constraint. And more importantly,\n' +
      'without an index on uen every one of the 87,037 badge updates would be a\n' +
      'full scan of 2M rows — the load would never finish.\n\n' +
      'Building the index takes a few minutes, once.'
    );
  }

  for (const table of ['company_changes', 'data_versions']) {
    const [r] = await execute([{
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, args: [table]
    }]);
    if (!rows(r).length) {
      throw new Error(`Table \`${table}\` not found. Run migrations 001 and 003 first.`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Phase runner
// ──────────────────────────────────────────────────────────────────────────

async function runPhase(phase, dir, args, cp) {
  const file = path.join(dir, `${phase}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${phase}.jsonl in ${dir}`);

  const total = args.limit || countLines(file);
  const skip = cp.done[phase];

  if (skip >= total) {
    console.log(`  ${phase.padEnd(8)} already complete (${fmt(total)} rows)`);
    return 0;
  }
  if (skip > 0) {
    console.log(`  ${phase.padEnd(8)} resuming at row ${fmt(skip)} of ${fmt(total)}`);
  }

  const build = BUILDERS[phase];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let seen = 0;
  let written = 0;
  let batch = [];
  // The highest line number actually placed in a batch — which is NOT the
  // same as `seen`. `seen` runs one ahead at the moment a --limit break
  // fires, and checkpointing that value would mark a row done that was never
  // applied, so a later full run would resume past it and drop it silently.
  let lastBatched = skip;
  const started = Date.now();
  // Seeded to the start time, not zero, so a phase that finishes inside two
  // seconds prints its summary line only — no half-drawn progress meter left
  // sitting behind it.
  let lastReport = started;

  const flush = async () => {
    if (!batch.length) return;
    if (args.apply) await execute(batch, { mode: 'write' });
    written += batch.length;
    cp.done[phase] = lastBatched;
    if (args.apply) saveCheckpoint(cp);
    batch = [];

    const now = Date.now();
    if (now - lastReport > 2000) {
      const rate = written / ((now - started) / 1000);
      const left = total - lastBatched;
      const eta = rate > 0 ? Math.round(left / rate) : 0;
      process.stdout.write(
        `\r  ${phase.padEnd(8)} ${fmt(lastBatched)} / ${fmt(total)}  ` +
        `${Math.round(rate)}/s  eta ${eta}s        `
      );
      lastReport = now;
    }
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    seen++;
    if (seen <= skip) continue;
    if (args.limit && seen > args.limit) break;

    batch.push(build(JSON.parse(line)));
    lastBatched = seen;
    if (batch.length >= args.batch) await flush();
  }
  await flush();

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `\r  ${phase.padEnd(8)} ${fmt(written)} rows in ${secs}s` +
    `${args.apply ? '' : ' (dry run — nothing sent)'}                    \n`
  );
  return written;
}

function countLines(file) {
  // Counting bytes for newlines is fast enough on a 663MB file and avoids
  // holding it in memory.
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let count = 0, read;
  while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    for (let i = 0; i < read; i++) if (buf[i] === 10) count++;
  }
  fs.closeSync(fd);
  return count;
}

// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node scripts/apply-diff.js --dir <diff dir> [--apply] [--limit n] [--batch n] [--restart]');
    process.exit(1);
  }

  const dir = path.resolve(args.dir);
  const summaryPath = path.join(dir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`No summary.json in ${dir} — is this a diff directory produced by diff-acra.js?`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const month = summary.month;

  console.log('');
  console.log(`Diff        : ${dir}`);
  console.log(`Month       : ${month}`);
  console.log(`Mode        : ${args.apply ? 'APPLY (writes to Turso)' : 'DRY RUN (nothing sent)'}`);
  if (args.limit) console.log(`Limit       : first ${fmt(args.limit)} rows of each file`);
  console.log(`Batch size  : ${args.batch} statements per request`);
  console.log('');

  if (args.apply) await preflight();

  const cp = loadCheckpoint(dir, args.restart);
  if (!args.restart && Object.values(cp.done).some(v => v > 0)) {
    console.log('Resuming from checkpoint. Use --restart to start over.');
    console.log('');
  }

  const counts = {};
  for (const phase of PHASES) {
    counts[phase] = await runPhase(phase, dir, args, cp);
  }

  // ── Stamp the release ───────────────────────────────────────────────────
  // Last, and only on a complete unlimited run. This is the switch that makes
  // the new month's badges visible, so it must not flip while rows are still
  // arriving — and a --limit run is a trial, not a release.

  if (!args.apply) {
    console.log('');
    console.log('Dry run complete. Nothing was written. Re-run with --apply.');
  } else if (args.limit) {
    console.log('');
    console.log(`Limited run — data_versions NOT stamped, so ${month} badges stay hidden.`);
    console.log('Inspect the rows that landed, then run without --limit.');
  } else {
    // Read the changelog total back rather than using this run's write count.
    // A resumed run only writes the rows it had left to do, so counting them
    // would under-report the month — 12 instead of 15 after a resume. Cheap:
    // idx_changes_month_type covers exactly this lookup.
    const [cnt] = await execute([{
      sql: `SELECT COUNT(*) AS n FROM company_changes WHERE change_month = ?`,
      args: [month],
    }]);
    const changesForMonth = Number(rows(cnt)[0]?.n ?? counts.changes);

    // companies_total means "rows in the companies table after this load",
    // not "rows in the ACRA release". The two differ: the loader never
    // deletes, so a UEN that disappears from a release stays in the table.
    // April→August that is 2 rows — small, but the frontend shows this number
    // in the header and uses it as the unfiltered result count, so it should
    // describe the table it is counting.
    //
    // Derived rather than counted: COUNT(*) over 2M rows is the one thing
    // this project never does casually. previous total + rows inserted is
    // exact, because inserts are the only thing that changes the row count.
    const [prev] = await execute([{
      sql: `SELECT companies_total FROM data_versions
             WHERE month < ? ORDER BY month DESC LIMIT 1`,
      args: [month],
    }]);
    const previousTotal = Number(rows(prev)[0]?.companies_total || 0);
    const tableTotal = previousTotal
      ? previousTotal + (summary.stats?.newRows ?? 0)
      : summary.new_rows;   // first ever load: the release IS the table

    await execute([{
      sql: `INSERT INTO data_versions
              (month, loaded_at, source, companies_total, rows_inserted, rows_updated, changes_recorded)
            VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
            ON CONFLICT(month) DO UPDATE SET
              loaded_at        = excluded.loaded_at,
              companies_total  = excluded.companies_total,
              rows_inserted    = excluded.rows_inserted,
              rows_updated     = excluded.rows_updated,
              changes_recorded = excluded.changes_recorded`,
      args: [month, summary.new_release || 'data.gov.sg ACRA release',
             tableTotal, summary.stats?.newRows ?? 0,
             summary.stats?.changedAnyColumn ?? 0, changesForMonth],
    }], { mode: 'write' });

    cp.stamped = true;
    saveCheckpoint(cp);

    console.log('');
    console.log(`Stamped data_versions for ${month} — badges for this month are now live.`);
  }

  console.log('');
  console.log('Run  node scripts/db-status.js  to confirm.');
  console.log('');
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
