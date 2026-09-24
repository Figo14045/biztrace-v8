// Tests for spend tracking.
//
// The claim being defended is narrow and worth stating: the recorded total
// must cover every call the provider CHARGED for, not every call that
// produced a usable result. Those differ, and the difference grows when a run
// is going wrong — which is when the number matters.
//
// So the tests care mostly about the awkward cases: a lookup that was billed
// and then failed to parse, an engine that bills in quota rather than dollars,
// and a retry that costs twice. A test that only checked the happy path would
// pass against a design that silently understates the bill.
//
// Schema comes from the real migration file, so a change there that breaks
// these queries is caught here rather than in production.
//
// Run: node scripts/test-spend-tracking.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SAVE = fs.readFileSync(path.join(ROOT, 'netlify/functions/enrich-save.js'), 'utf8');
const OR   = fs.readFileSync(path.join(ROOT, 'netlify/functions/openrouter-enrich.js'), 'utf8');
const MIG  = fs.readFileSync(path.join(ROOT, 'migrations/008_usage_log.sql'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function extractFunction(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = src.search(re);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// ── The migration must actually run ──────────────────────────────────────
console.log('\nMigration 008');
const db = new DatabaseSync(':memory:');
try {
  db.exec(MIG);
  check('008 applies cleanly', true);
} catch (e) {
  check('008 applies cleanly', false, e.message);
}
check('re-running 008 is safe (IF NOT EXISTS)', (() => {
  try { db.exec(MIG); return true; } catch (e) { return false; }
})());

// cost_usd must accept NULL — "not billed in dollars" is not zero.
db.exec(`INSERT INTO usage_log (called_at, uen, engine, cost_usd, outcome)
         VALUES ('2026-09-20T01:00:00Z','U9','ai',NULL,'ok')`);
check('cost_usd accepts NULL for a non-dollar engine',
      db.prepare(`SELECT cost_usd FROM usage_log WHERE uen='U9'`).get().cost_usd === null);
db.exec(`DELETE FROM usage_log`);

// ── The write statement ──────────────────────────────────────────────────
console.log('\nWrite path');
{
  const sb = { Number, String, parseInt, Set, console };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(extractFunction(SAVE, 'buildUsageStatement'), sb);

  const st = sb.buildUsageStatement(
    { uen: 'U1', engine: 'openrouter', model_used: 'anthropic/claude-haiku-4.5',
      cost_usd: 0.0113, prompt_tokens: 900, completion_tokens: 210, outcome: 'ok' },
    '2026-09-20T02:00:00Z');
  check('builds an INSERT, not an upsert',
        /^\s*INSERT INTO usage_log/.test(st.sql) && !/ON CONFLICT/.test(st.sql),
        'deduplicating by uen would hide double-spend');
  db.prepare(st.sql).run(...st.args);
  const row = db.prepare(`SELECT * FROM usage_log WHERE uen='U1'`).get();
  check('cost is stored as given', row.cost_usd === 0.0113, String(row.cost_usd));
  check('tokens are stored', row.prompt_tokens === 900 && row.completion_tokens === 210);

  // A second call for the same company is a second charge.
  db.prepare(st.sql).run(...st.args);
  check('two calls for one company make two rows',
        db.prepare(`SELECT COUNT(*) n FROM usage_log WHERE uen='U1'`).get().n === 2);

  // Rubbish must not become a number.
  const bad = sb.buildUsageStatement(
    { uen: 'U2', engine: 'openrouter', cost_usd: 'free', prompt_tokens: '', outcome: 'nonsense' },
    '2026-09-20T02:01:00Z');
  db.prepare(bad.sql).run(...bad.args);
  const b = db.prepare(`SELECT * FROM usage_log WHERE uen='U2'`).get();
  check('a non-numeric cost becomes NULL, not 0', b.cost_usd === null, String(b.cost_usd));
  check('an unknown outcome falls back to ok', b.outcome === 'ok', b.outcome);
}

// ── The summary query ────────────────────────────────────────────────────
console.log('\nSpend summary');
{
  db.exec(`DELETE FROM usage_log`);
  db.exec(`INSERT INTO usage_log (called_at, uen, engine, cost_usd, prompt_tokens, completion_tokens, outcome) VALUES
    ('2026-09-18T10:00:00Z','A','openrouter',0.011,900,200,'ok'),
    ('2026-09-18T10:01:00Z','B','openrouter',0.012,950,210,'ok'),
    ('2026-09-18T10:02:00Z','C','openrouter',0.009,800,0,'failed'),
    ('2026-09-18T10:03:00Z','D','ai',NULL,0,0,'ok'),
    ('2026-09-25T10:00:00Z','E','openrouter',0.500,9000,900,'ok')`);

  // Same SQL shape as query.js's spend_summary.
  const totals = (from, to) => {
    const w = [], a = [];
    if (from) { w.push('called_at >= ?'); a.push(from); }
    if (to)   { w.push('called_at < ?');  a.push(to); }
    const clause = w.length ? `WHERE ${w.join(' AND ')}` : '';
    return db.prepare(`SELECT COUNT(*) AS calls,
        SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS calls_without_cost,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_calls,
        SUM(cost_usd) AS cost_usd FROM usage_log ${clause}`).get(...a);
  };

  const sept18 = totals('2026-09-18', '2026-09-19');
  check('the range excludes calls outside it', sept18.calls === 4, `got ${sept18.calls}`);
  check('a billed-but-failed call is counted in the cost',
        Math.abs(sept18.cost_usd - 0.032) < 1e-9, String(sept18.cost_usd));
  check('failed calls are reported separately', sept18.failed_calls === 1);
  check('calls with no dollar cost are reported separately',
        sept18.calls_without_cost === 1);

  const all = totals(null, null);
  check('an open range covers everything', all.calls === 5, `got ${all.calls}`);

  // The distinction the whole design rests on.
  const okOnly = db.prepare(
    `SELECT SUM(cost_usd) c FROM usage_log WHERE outcome='ok' AND called_at < '2026-09-19'`).get().c;
  check('counting only successes would understate the bill',
        Math.abs(okOnly - 0.023) < 1e-9 && okOnly < sept18.cost_usd,
        `ok-only ${okOnly} vs all ${sept18.cost_usd}`);
}

// ── Wiring ───────────────────────────────────────────────────────────────
console.log('\nWiring');
{
  check('the request asks OpenRouter to report cost',
        /usage:\s*\{\s*include:\s*true\s*\}/.test(OR), 'usage.include missing from the request body');
  check('usage is returned on failure paths too',
        (OR.match(/usageFrom\(apiResp, 'failed'\)/g) || []).length >= 3,
        'a billed-but-unusable call would go unrecorded');
  check('usage is returned on the success path',
        /usageFrom\(apiResp, 'ok'\)/.test(OR));

  check("'usage' is an allowlisted action", /'usage'/.test(SAVE) && /ACTIONS = new Set\(\[[^\]]*'usage'/.test(SAVE));

  const enrichSrc = extractFunction(HTML, 'enrichOneOpenRouter');
  const logIdx = enrichSrc.indexOf('logUsage');
  const throwIdx = enrichSrc.indexOf("if (!json) throw");
  check('the charge is logged BEFORE the result is judged',
        logIdx !== -1 && logIdx < throwIdx,
        'a failed lookup would be thrown away before its cost was recorded');

  const flush = extractFunction(HTML, 'flushUsage');
  check('a failed spend write is retried, not dropped',
        /usageBuffer = batch\.concat\(usageBuffer\)/.test(flush));
  check('a failed spend write never throws into the run',
        !/throw/.test(flush.split('catch')[1] || ''));

  const startSrc = extractFunction(HTML, 'startEnrich');
  check('the spend log is flushed when a run ends',
        (startSrc.match(/await flushUsage\(\)/g) || []).length >= 3,
        'every exit path must flush');

  const summary = extractFunction(HTML, 'loadSpendSummary');
  check('the UI says "recorded", not "spent"',
        /Recorded cost/.test(summary) && !/Total spent/.test(summary));
  check('the UI names the timeout gap rather than implying completeness',
        /timeout is billed but never reaches us/.test(summary));

  const fmt = extractFunction(HTML, 'formatUsd');
  const sb2 = { isFinite }; sb2.globalThis = sb2;
  vm.createContext(sb2); vm.runInContext(fmt, sb2);
  check('a null cost renders as a dash, not $0.00',
        sb2.formatUsd(null) === '—', sb2.formatUsd(null));
  check('sub-cent amounts keep their precision',
        sb2.formatUsd(0.0113) === 'US$0.0113', sb2.formatUsd(0.0113));
  check('larger amounts round to cents', sb2.formatUsd(5.499) === 'US$5.50', sb2.formatUsd(5.499));
}

// ── The Spend view ───────────────────────────────────────────────────────
console.log('\nSpend view');
{
  const chart = extractFunction(HTML, 'renderSpendChart');

  // A day with no calls must be drawn as an empty slot, not skipped. Skipping
  // makes a quiet week look like missing data and silently compresses the
  // x-axis, so two bars that appear adjacent may be weeks apart.
  check('gaps in the date range are filled, not skipped',
        /setUTCDate\(d\.getUTCDate\(\) \+ 1\)/.test(chart) && /byDay\.get\(key\) \|\|/.test(chart),
        'days with no activity would be dropped from the axis');

  check('bars, not a line (each day is a discrete total)',
        /<rect/.test(chart) && !/<polyline|<path/.test(chart));
  check('every bar carries a hover title',
        /<title>\$\{title\}<\/title>/.test(chart));
  check('dates are labelled selectively, not one per bar',
        /i % step === 0/.test(chart));
  check('chart text uses theme tokens, not a series colour',
        /class="sp-axis"/.test(chart) && !/fill="#/.test(chart));
  check('the axis is labelled in money', /formatUsd\(t\)/.test(chart));

  // A single series needs no legend; the card heading names it. Guard against
  // someone adding a second series later without one.
  check('single series, so no legend box', !/legend/i.test(chart));

  // Render it for real and sanity-check the geometry.
  const sb3 = { Math, Number, String, Map, Date, isFinite, document: null };
  sb3.globalThis = sb3;
  vm.createContext(sb3);
  vm.runInContext(extractFunction(HTML, 'formatUsd') + '\n' + chart + `
    let __html = null;
    document = { getElementById: () => ({ set innerHTML(v) { __html = v; } }) };
    function __render(days) { renderSpendChart(days); return __html; }
  `, sb3);

  const svg = sb3.__render([
    { day: '2026-09-18', calls: 3, cost_usd: 0.033, failed_calls: 0 },
    { day: '2026-09-21', calls: 1, cost_usd: 0.011, failed_calls: 0 },
  ]);
  check('renders an svg', /^<svg/.test(svg.trim()), svg.slice(0, 40));
  check('the two silent days between are drawn',
        (svg.match(/<rect/g) || []).length === 4,
        `${(svg.match(/<rect/g) || []).length} rects for a 4-day span`);
  check('no NaN reaches the output', !/NaN/.test(svg));
  check('bars stay inside the plot area', (() => {
    const ys = [...svg.matchAll(/<rect[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)];
    return ys.every(m => Number(m[1]) >= 0 && Number(m[1]) + Number(m[2]) <= 180.5);
  })(), 'a bar overflows the viewBox');

  const empty = sb3.__render([]);
  check('an empty range says so instead of drawing nothing',
        /No lookups recorded/.test(empty));

  // Tiles must not invent a zero where the engine does not bill in dollars.
  const tiles = extractFunction(HTML, 'renderSpendTiles');
  check('tiles show recorded cost, with failures called out',
        /Recorded cost/.test(tiles) && /still charged/.test(tiles));
  const engines = extractFunction(HTML, 'renderSpendEngines');
  check("a non-dollar engine reads 'not billed in $', not $0.00",
        /not billed in \$/.test(engines));
}

// ── Billed vs recorded ───────────────────────────────────────────────────
console.log('\nOpenRouter account panel');
{
  const fn = extractFunction(HTML, 'loadAccountUsage');

  check('an uncapped key reads "No cap", not $0.00',
        /No cap/.test(fn) && /j\.remaining == null/.test(fn),
        'unlimited and empty would look the same');
  check('the lifetime total is shown',
        /Total to date/.test(fn) && /formatUsd\(j\.usage\)/.test(fn),
        'the all-time figure from OpenRouter is fetched but not displayed');
  check('it is labelled as key-scoped, not account-scoped',
        /All time on this key/.test(fn));
  check('the endpoint actually returns it',
        /usage:\s*num\(d\.usage\)/.test(
          fs.readFileSync(path.join(ROOT, 'netlify/functions/openrouter-usage.js'), 'utf8')));

  check('a low balance is called out',
        /j\.remaining < 5/.test(fn) && /sp-low/.test(fn));
  check('both figures are shown, not one replacing the other',
        /billed by OpenRouter/.test(fn) && /recorded here/.test(fn));
  check('the gap is explained rather than hidden',
        /function timeout/.test(fn) && /settling/.test(fn));
  check('the panel failing does not break the Spend view',
        /card\.hidden = true/.test(fn) && /catch/.test(fn));

  // The reconciliation line is rendered fresh each time the range changes.
  // insertAdjacentHTML appended instead of replacing, so every click of
  // Today / 7 days / 30 days left another identical paragraph on the page.
  check('the reconciliation line is replaced, not appended',
        // Match the CALL, not the word: the comment above the fix names the
        // old API, and a bare word match flagged that as the bug.
        /recon\.innerHTML = ''/.test(fn) && !/insertAdjacentHTML\s*\(/.test(fn),
        'appending would stack a duplicate on every filter click');
  check('it renders into its own container',
        /getElementById\('sp-recon'\)/.test(fn));
  check('the container exists in the markup', /id="sp-recon"/.test(HTML));

  // The comparison window must match how OpenRouter buckets its month, or the
  // two sides describe different periods for the first hours of each day.
  const ms = extractFunction(HTML, 'utcMonthStart');
  check('the month window is UTC, matching OpenRouter',
        /getUTCFullYear/.test(ms) && /getUTCMonth/.test(ms) && !/Asia\/Singapore/.test(ms));

  const sb4 = { Date, String }; sb4.globalThis = sb4;
  vm.createContext(sb4); vm.runInContext(ms, sb4);
  check('it returns the first of a month', /^\d{4}-\d{2}-01$/.test(sb4.utcMonthStart()),
        sb4.utcMonthStart());

  const SRC = fs.readFileSync(path.join(ROOT, 'netlify/functions/openrouter-usage.js'), 'utf8');
  check('the endpoint requires a session', /auth\.requireAuth\(event/.test(SRC));
  check('the API key never reaches the browser',
        !/OPENROUTER_API_KEY/.test(SRC.split('return {')[1] || ''),
        'the key must not appear in any response body');
  check('a slow OpenRouter cannot hold the function open',
        /AbortController/.test(SRC) && /TIMEOUT_MS/.test(SRC));
  check('an OpenRouter failure returns ok:false rather than a 500',
        /statusCode: 200[\s\S]{0,120}ok: false/.test(SRC));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
