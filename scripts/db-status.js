#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// Read-only snapshot of the change-tracking schema. Run it before and after
// a migration to see exactly what moved.
//
//   node scripts/db-status.js
//
// Uses the READ-ONLY token, so it cannot alter anything even by accident.
//
// Every count here is deliberately cheap: data_versions and company_changes
// are small tables, and the companies count is NOT recomputed — it is read
// back from data_versions. COUNT(*) across 2M rows is the one thing this
// project has learned never to do casually.
// ══════════════════════════════════════════════════════════════════════════

const { execute, rows } = require('./lib/turso');

async function tableExists(name) {
  const [r] = await execute([{
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    args: [name]
  }]);
  return rows(r).length > 0;
}

async function columnsOf(table) {
  const [r] = await execute([{ sql: `PRAGMA table_info(${table})` }]);
  return rows(r).map(c => c.name);
}

// ── Migration detection ───────────────────────────────────────────────────
// Each migration leaves a fingerprint in the schema or the data, so applied
// state can be read back rather than remembered. Every probe below is either
// a sqlite_master lookup or an index-backed equality — nothing here scans the
// 2M-row companies table.

async function migrationStatus(companyCols) {
  const out = [];

  // 001 — the badge columns and the two new tables.
  const has001 = companyCols.includes('change_status') &&
                 await tableExists('data_versions') &&
                 await tableExists('company_changes');
  out.push(['001 change-tracking schema', has001]);

  // 003 — dropped the CHECK constraint from company_changes. Read the stored
  // CREATE statement back and look for it.
  if (!(await tableExists('company_changes'))) {
    out.push(['003 widened change types', false, 'company_changes missing']);
  } else {
    const [r] = await execute([{
      sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='company_changes'`
    }]);
    const ddl = rows(r)[0]?.sql || '';
    out.push(['003 widened change types', !/CHECK\s*\(/i.test(ddl),
              /CHECK\s*\(/i.test(ddl) ? 'CHECK constraint still present' : '']);
  }

  // 002 — the postal repair. Probed by equality on a value known to exist in
  // the unrepaired data (UEN 200302330D and neighbours sit at 079903, stored
  // as 79903 before the fix). This is an index-backed lookup, not a scan.
  //
  // Skipped entirely if postal_code has no index, because without one the
  // "already fixed" case is the slow one — it would have to walk all 2M rows
  // to prove the absence.
  const [idxR] = await execute([{
    sql: `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='companies'`
  }]);
  const indexed = rows(idxR).some(i => /postal_code/i.test(i.sql || ''));

  if (!indexed) {
    out.push(['002 postal leading zeros', null, 'no postal_code index — probe skipped']);
  } else {
    const [probe] = await execute([{
      sql: `SELECT COUNT(*) AS n FROM companies WHERE postal_code = '79903'`
    }]);
    const stale = Number(rows(probe)[0]?.n || 0);
    out.push(['002 postal leading zeros', stale === 0,
              stale > 0 ? `${stale} companies still at the 5-digit value` : '']);
  }

  return out;
}

async function main() {
  console.log('');
  console.log('BizTrace — change-tracking schema status');
  console.log('════════════════════════════════════════════════════════════');

  // 1. companies badge columns
  const companyCols = await columnsOf('companies');
  const hasStatus = companyCols.includes('change_status');
  const hasMonth  = companyCols.includes('change_month');

  console.log('');
  console.log(`companies — ${companyCols.length} columns`);
  console.log(`  change_status : ${hasStatus ? 'present' : 'MISSING'}`);
  console.log(`  change_month  : ${hasMonth ? 'present' : 'MISSING'}`);

  if (hasStatus) {
    // Cheap because of the partial index: it only carries changed rows.
    const [r] = await execute([{
      sql: `SELECT change_month, change_status, COUNT(*) AS n
              FROM companies
             WHERE change_status IS NOT NULL
          GROUP BY change_month, change_status
          ORDER BY change_month DESC, n DESC`
    }]);
    const badges = rows(r);
    if (!badges.length) {
      console.log('  badges        : none set yet');
    } else {
      console.log('  badges        :');
      for (const b of badges) {
        console.log(`      ${b.change_month}  ${String(b.change_status).padEnd(16)} ${b.n}`);
      }
    }
  }

  // 2. data_versions
  console.log('');
  if (!(await tableExists('data_versions'))) {
    console.log('data_versions — MISSING (migration 001 not applied)');
  } else {
    const [r] = await execute([{
      sql: `SELECT month, loaded_at, companies_total, rows_inserted,
                   rows_updated, changes_recorded
              FROM data_versions
          ORDER BY month DESC`
    }]);
    const versions = rows(r);
    console.log(`data_versions — ${versions.length} release(s) loaded`);
    for (const v of versions) {
      console.log(`  ${v.month}  total=${v.companies_total}  ` +
                  `+${v.rows_inserted ?? 0}/~${v.rows_updated ?? 0}  ` +
                  `changes=${v.changes_recorded ?? 0}  (${v.loaded_at})`);
    }
    if (versions.length) {
      console.log(`  current release: ${versions[0].month}  ` +
                  `— badges render only for this month`);
    }
  }

  // 3. company_changes
  console.log('');
  if (!(await tableExists('company_changes'))) {
    console.log('company_changes — MISSING (migration 001 not applied)');
  } else {
    const [r] = await execute([{
      sql: `SELECT change_month, change_type, COUNT(*) AS n
              FROM company_changes
          GROUP BY change_month, change_type
          ORDER BY change_month DESC, n DESC`
    }]);
    const changes = rows(r);
    const total = changes.reduce((a, c) => a + Number(c.n), 0);
    console.log(`company_changes — ${total} row(s)`);
    for (const c of changes) {
      console.log(`  ${c.change_month}  ${String(c.change_type).padEnd(16)} ${c.n}`);
    }
    if (!changes.length) {
      console.log('  (empty — expected until the first diff runs)');
    }
  }

  // 4. indexes on companies
  //
  // Worth showing because index shape is what decides whether a query on this
  // table is instant or a 2M-row scan — the single most load-bearing fact
  // about this schema, and the cause of every timeout the project has hit.
  console.log('');
  const [ixR] = await execute([{
    sql: `SELECT name, sql FROM sqlite_master
           WHERE type='index' AND tbl_name='companies' ORDER BY name`
  }]);
  const idx = rows(ixR);
  console.log(`indexes on companies — ${idx.length}`);
  for (const i of idx) {
    if (!i.sql) {
      // Auto-indexes backing a PRIMARY KEY or UNIQUE column have no SQL.
      console.log(`  ${i.name}  (implicit)`);
      continue;
    }
    const cols = (i.sql.match(/\(([^)]*)\)/) || [, '?'])[1].replace(/"/g, '').trim();
    const uniq = /CREATE\s+UNIQUE/i.test(i.sql) ? 'UNIQUE ' : '';
    const partial = /\bWHERE\b/i.test(i.sql) ? ' [partial]' : '';
    console.log(`  ${i.name.padEnd(30)} ${uniq}(${cols})${partial}`);
  }

  // 5. migrations
  console.log('');
  console.log('migrations');
  for (const [name, applied, note] of await migrationStatus(companyCols)) {
    const mark = applied === null ? '?' : (applied ? 'applied' : 'NOT APPLIED');
    console.log(`  ${name.padEnd(28)} ${mark}${note ? `  — ${note}` : ''}`);
  }

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
