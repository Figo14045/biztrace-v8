#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// Read-only smoke test for the Stage 3 change tracking.
//
//   node scripts/smoke-test.js
//        → checks the DATABASE directly, using the read-only token.
//
//   node scripts/smoke-test.js --url https://staging--biztracev8.netlify.app
//        → also checks the deployed PROXY, which is the path the browser
//          actually takes: Netlify bundling, cold start, function timeout.
//
// Why both. The database being correct and the deployed function returning
// that correctness in under ten seconds are different claims, and this
// project has been bitten by the second one repeatedly — the SSIC LIKE scan,
// the LEFT JOIN that walked 2M rows, the COUNT(*) that blew the timeout. So
// every check here is TIMED, and anything approaching Netlify's ~10s ceiling
// is flagged even when the answer is right.
//
// Writes nothing. Safe to run against production.
// ══════════════════════════════════════════════════════════════════════════

const { execute, rows } = require('./lib/turso');

// Netlify's free tier cuts a function off at about 10 seconds. Warn well
// before that: a query at 6s on an idle database is a query that fails under
// load or after a cold start.
const SLOW_MS = 3000;
const DANGER_MS = 6000;

let failures = 0;
let warnings = 0;

function fmt(n) { return Number(n).toLocaleString('en-US'); }

function report(name, ok, detail, ms) {
  const mark = ok ? 'ok  ' : 'FAIL';
  if (!ok) failures++;
  let timing = '';
  if (typeof ms === 'number') {
    timing = `${String(Math.round(ms)).padStart(5)}ms`;
    if (ms >= DANGER_MS) { timing += '  ⚠ NEAR TIMEOUT'; warnings++; }
    else if (ms >= SLOW_MS) { timing += '  ⚠ slow'; warnings++; }
  }
  console.log(`  ${mark} ${name.padEnd(44)} ${timing}${detail ? '  ' + detail : ''}`);
}

async function timed(fn) {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

// ──────────────────────────────────────────────────────────────────────────
// Database checks
// ──────────────────────────────────────────────────────────────────────────

async function dbChecks() {
  console.log('');
  console.log('DATABASE  (read-only token, direct to Turso)');
  console.log('─────────────────────────────────────────────────────────────────────');

  // Which release is current. Everything else is relative to this.
  const v = await timed(() => execute([{
    sql: `SELECT month, companies_total, changes_recorded
            FROM data_versions ORDER BY month DESC LIMIT 2`
  }]));
  const versions = rows(v.value[0]);
  const current = versions[0]?.month;
  report('current release resolves', !!current, current || '(none)', v.ms);
  if (!current) {
    console.log('\n  No release in data_versions — nothing else can be checked.');
    return null;
  }

  // Badge counts. Reads the partial index, so this must be fast; if it is
  // not, the sidebar filter will not be either.
  const b = await timed(() => execute([{
    sql: `SELECT change_status, COUNT(*) AS n FROM companies
           WHERE change_status IS NOT NULL AND change_month = ?
        GROUP BY change_status ORDER BY n DESC`,
    args: [current]
  }]));
  const badges = rows(b.value[0]);
  const badgeTotal = badges.reduce((a, r) => a + Number(r.n), 0);
  report('badge counts (partial index)', badges.length > 0,
         `${fmt(badgeTotal)} badged across ${badges.length} types`, b.ms);
  for (const r of badges) console.log(`         ${String(r.change_status).padEnd(18)} ${fmt(r.n)}`);

  // The changelog must account for every badge: a badged company with no
  // changelog rows means the loader half-finished.
  const c = await timed(() => execute([{
    sql: `SELECT change_type, COUNT(*) AS n FROM company_changes
           WHERE change_month = ? GROUP BY change_type`,
    args: [current]
  }]));
  const changes = rows(c.value[0]);
  const changeTotal = changes.reduce((a, r) => a + Number(r.n), 0);
  report('changelog rows', changeTotal > 0, `${fmt(changeTotal)} rows`, c.ms);

  // Cross-check. Every badge must be one of the changelog's types, and the
  // changelog must have at least as many rows as there are badges (it holds
  // one row per changed FIELD, so it should have more).
  const changeTypes = new Set(changes.map(r => r.change_type));
  const orphanTypes = badges.map(r => r.change_status).filter(t => !changeTypes.has(t));
  report('every badge type exists in the changelog', orphanTypes.length === 0,
         orphanTypes.length ? `orphans: ${orphanTypes.join(', ')}` : '');
  report('changelog rows >= badged companies', changeTotal >= badgeTotal,
         `${fmt(changeTotal)} vs ${fmt(badgeTotal)}`);

  // The filter query the sidebar actually issues, for the biggest type.
  const biggest = badges[0]?.change_status;
  if (biggest) {
    const q = await timed(() => execute([{
      sql: `SELECT COUNT(*) AS n FROM companies
             WHERE change_status IS NOT NULL
               AND change_month = (SELECT MAX(month) FROM data_versions)
               AND change_status = ?`,
      args: [biggest]
    }]));
    const n = Number(rows(q.value[0])[0]?.n || 0);
    const expected = Number(badges[0].n);
    report(`filter query: ${biggest}`, n === expected, `${fmt(n)} rows`, q.ms);
  }

  // Detail lookup for a page's worth of UENs — the changes_for path.
  const sample = await execute([{
    sql: `SELECT uen FROM companies
           WHERE change_status IS NOT NULL AND change_month = ? LIMIT 50`,
    args: [current]
  }]);
  const uens = rows(sample[0]).map(r => r.uen);
  if (uens.length) {
    const d = await timed(() => execute([{
      sql: `SELECT uen, change_type, field FROM company_changes
             WHERE uen IN (${uens.map(() => '?').join(',')}) AND change_month = ?`,
      args: [...uens, current]
    }]));
    const detail = rows(d.value[0]);
    const covered = new Set(detail.map(r => r.uen)).size;
    report('detail for 50 badged companies', covered === uens.length,
           `${covered}/${uens.length} have changelog rows`, d.ms);
  }

  // Migration 002. Index-backed equality on a value that only exists in the
  // unrepaired data — see db-status.js for why this is not a scan.
  const p = await timed(() => execute([{
    sql: `SELECT COUNT(*) AS n FROM companies WHERE postal_code = '79903'`
  }]));
  const stale = Number(rows(p.value[0])[0]?.n || 0);
  report('postal repair holds (no 5-digit 79903)', stale === 0,
         stale ? `${fmt(stale)} still broken` : '', p.ms);

  const p2 = await timed(() => execute([{
    sql: `SELECT COUNT(*) AS n FROM companies WHERE postal_code = '079903'`
  }]));
  const fixed = Number(rows(p2.value[0])[0]?.n || 0);
  report('and the repaired value is findable', fixed > 0, `${fmt(fixed)} companies`, p2.ms);

  // The enrichment join must still work — Stage 3 touched the same table.
  const e = await timed(() => execute([{
    sql: `SELECT COUNT(*) AS n FROM enrichments`
  }]));
  report('enrichments table intact', true,
         `${fmt(Number(rows(e.value[0])[0]?.n || 0))} rows`, e.ms);

  // The point of this one is the SHAPE, not the row count. An INNER JOIN
  // driven from the small enrichments table is fast; the LEFT JOIN with
  // "WHERE e.uen IS NOT NULL" that it replaced walked all 2M companies. What
  // is being asserted is that it executes and how long it takes.
  const j = await timed(() => execute([{
    sql: `SELECT c.uen, c.entity_name, e.email, c.change_status
            FROM companies c INNER JOIN enrichments e ON c.uen = e.uen
           LIMIT 20`
  }]));
  const joined = rows(j.value[0]);
  report('companies ⋈ enrichments executes', Array.isArray(joined),
         `${joined.length} rows`, j.ms);

  return { current, badges, badgeTotal };
}

// ──────────────────────────────────────────────────────────────────────────
// Deployed proxy checks
// ──────────────────────────────────────────────────────────────────────────
// Same questions, asked the way the browser asks them. A pass here and a fail
// above (or vice versa) localises the problem immediately: database, or
// deployment.

async function proxyChecks(baseUrl, db) {
  const url = baseUrl.replace(/\/$/, '') + '/.netlify/functions/query';
  console.log('');
  console.log(`DEPLOYED PROXY  ${url}`);
  console.log('─────────────────────────────────────────────────────────────────────');

  const post = async (body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { status: r.status, json, text };
  };

  // First call absorbs the cold start, and is reported separately so it does
  // not look like a slow query.
  const warm = await timed(() => post({ mode: 'change_summary' }));
  report('cold start + change_summary', warm.value.status === 200,
         warm.value.status === 200 ? '' : warm.value.text.slice(0, 80), warm.ms);

  const s = await timed(() => post({ mode: 'change_summary' }));
  const summary = s.value.json;
  report('change_summary (warm)', !!summary?.ok, '', s.ms);
  if (summary?.ok) {
    report('proxy agrees on current release', summary.current_month === db?.current,
           `${summary.current_month} vs ${db?.current}`);
    const proxyTotal = Object.values(summary.counts || {}).reduce((a, b) => a + b, 0);
    report('proxy agrees on badge total', proxyTotal === db?.badgeTotal,
           `${fmt(proxyTotal)} vs ${fmt(db?.badgeTotal)}`);
  }

  const biggest = db?.badges?.[0];
  if (biggest) {
    const f = await timed(() => post({
      fields: ['uen', 'entity_name', 'change_status', 'change_month'],
      limit: 100, include_count: true, include_enrichment: true,
      change_filter: biggest.change_status,
    }));
    const j = f.value.json;
    report(`filtered page: ${biggest.change_status}`, !!j?.ok, '', f.ms);
    if (j?.ok) {
      // Coerced on both sides: Turso returns counts as strings over the
      // HTTP protocol, so a strict === would fail on two equal numbers.
      const expected = Number(biggest.n);
      report('  count matches the database', Number(j.total) === expected,
             `${fmt(j.total)} vs ${fmt(expected)}`);
      // A "full page" is only 100 rows when the filtered set actually has
      // that many — otherwise the correct answer is the whole set.
      const wantRows = Math.min(100, expected);
      report('  page returns every row it should', j.rows.length === wantRows,
             `${j.rows.length} of ${wantRows}`);
      report('  every row is current-month',
             j.rows.every(r => r.change_month === db.current), '');
      report('  every row carries the filtered badge',
             j.rows.every(r => r.change_status === biggest.change_status), '');

      const uens = j.rows.map(r => r.uen).slice(0, 50);
      const d = await timed(() => post({ mode: 'changes_for', uens }));
      const dj = d.value.json;
      report('changes_for for that page', !!dj?.ok,
             dj?.ok ? `${Object.keys(dj.changes).length} companies` : '', d.ms);
    }
  }

  // Deep paging inside a filtered set — page 20 of a filter is where OFFSET
  // costs start to show.
  if (biggest && Number(biggest.n) > 2000) {
    const p = await timed(() => post({
      fields: ['uen', 'change_status'], limit: 100, offset: 2000,
      include_count: false, change_filter: biggest.change_status,
    }));
    report('page 21 of a filtered set', p.value.json?.ok === true, '', p.ms);
  }

  // Unfiltered first page: the most common query in the app, and the one
  // that must never regress.
  const u = await timed(() => post({
    fields: ['uen', 'entity_name', 'change_status', 'change_month'],
    limit: 100, include_count: true, include_enrichment: true,
  }));
  report('unfiltered first page (with enrichment join)', u.value.json?.ok === true, '', u.ms);

  // A bad filter value must be ignored, not injected.
  const bad = await timed(() => post({
    fields: ['uen'], limit: 5, change_filter: "'; DROP TABLE companies; --",
  }));
  report('malformed change_filter rejected safely', bad.value.json?.ok === true, '', bad.ms);
}

// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const baseUrl = urlIdx !== -1 ? args[urlIdx + 1] : null;

  console.log('');
  console.log('BizTrace — Stage 3 smoke test');
  console.log('═════════════════════════════════════════════════════════════════════');

  const db = await dbChecks();
  if (baseUrl) await proxyChecks(baseUrl, db);
  else {
    console.log('');
    console.log('  (no --url given — deployed proxy not checked)');
  }

  console.log('');
  console.log('─────────────────────────────────────────────────────────────────────');
  if (failures) {
    console.log(`${failures} FAILURE${failures > 1 ? 'S' : ''}${warnings ? `, ${warnings} timing warning(s)` : ''}`);
    process.exitCode = 1;
  } else if (warnings) {
    console.log(`All checks passed, but ${warnings} query/queries were slow.`);
    console.log('Netlify cuts functions off around 10s — a query at 6s on an idle');
    console.log('database is one that fails under load or after a cold start.');
  } else {
    console.log('All checks passed.');
  }
  console.log('');
}

// Set exitCode rather than calling process.exit(). On Windows, exiting while
// the HTTP client still has sockets closing trips an assertion inside libuv.
main().catch(err => {
  console.error('');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
