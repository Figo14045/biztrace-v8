// Regression tests for the enrichment run loop and the write-back buffer.
//
// Four defects, all of which reported success or said nothing while something
// went wrong:
//
//   F10  The completion banner printed "Done — N companies enriched" using the
//        number of rows ATTEMPTED. A run where every call failed still claimed
//        a clean sweep. This is what a dead API key looked like.
//   F11  flushEnrichSaves emptied the buffer BEFORE the request and never put
//        it back on failure, so a database hiccup during a long run silently
//        discarded every batch of 10 lookups from that point on — lookups that
//        had already been paid for.
//   F12  Only the Gemini engine stopped on a systemic failure. The others
//        ground through the whole selection failing identically, at 1.2s each.
//   F14  approve/exported are plain UPDATEs. Matching zero rows is not an
//        error, so approving a result that was never saved answered ok:true
//        and wrote nothing.
//
// No browser, no network, no dependencies: the functions under test are pulled
// out of index.html and enrich-save.js and driven with stubs. Run:
//   node scripts/test-enrich-run.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

// ── F11: the write buffer ────────────────────────────────────────────────
function bufferSandbox() {
  const sb = {
    console: { log(){}, warn(){} },
    enrichData: {},
    toasts: [],
    showToast: m => sb.toasts.push(m),
    fetchImpl: null,
    Map, Array, Object, JSON, Promise, Error,
  };
  sb.globalThis = sb;
  sb.fetch = (...a) => sb.fetchImpl(...a);
  vm.createContext(sb);
  vm.runInContext(
    'let enrichSaveBuffer = [];\nlet enrichSaveFailures = 0;\n' +
    extractFunction(HTML, 'flushEnrichSaves') + '\n' +
    extractFunction(HTML, 'unsavedEnrichCount') + '\n' +
    'function setBuffer(b){ enrichSaveBuffer = b; }\n' +
    'function getBuffer(){ return enrichSaveBuffer; }\n',
    sb);
  return sb;
}

async function testBuffer() {
  console.log('\nF11 — write buffer retains results when the save fails');

  const sb = bufferSandbox();
  sb.enrichData['U1'] = {}; sb.enrichData['U2'] = {};
  sb.setBuffer([{ uen: 'U1' }, { uen: 'U2' }]);

  // A failing save must not lose the records.
  sb.fetchImpl = async () => ({ json: async () => ({ ok: false, error: 'turso down' }) });
  await sb.flushEnrichSaves();
  check('failed save keeps both records buffered',
        sb.unsavedEnrichCount() === 2, `buffer has ${sb.unsavedEnrichCount()}`);
  check('the user is told how many are waiting',
        /2 results waiting to retry/.test(sb.toasts.join('|')), sb.toasts.join('|'));

  // A later successful flush drains them and marks them persisted.
  let sent = null;
  sb.fetchImpl = async (url, opts) => {
    sent = JSON.parse(opts.body).records;
    return { json: async () => ({ ok: true, enriched_at: '2026-09-14T00:00:00Z' }) };
  };
  await sb.flushEnrichSaves();
  check('retry sends exactly the records that failed',
        sent && sent.length === 2 && sent[0].uen === 'U1', JSON.stringify(sent));
  check('buffer is empty after a successful retry',
        sb.unsavedEnrichCount() === 0, `buffer has ${sb.unsavedEnrichCount()}`);
  check('records are marked persisted', sb.enrichData['U1'].persisted === true);

  // A record re-enriched while an earlier copy is still unsaved must not
  // produce two rows for the same company.
  const sb2 = bufferSandbox();
  sb2.enrichData['U1'] = {};
  sb2.setBuffer([{ uen: 'U1', email: 'old@x.com' }]);
  sb2.fetchImpl = async () => { throw new Error('network down'); };
  await sb2.flushEnrichSaves();
  sb2.getBuffer().push({ uen: 'U1', email: 'new@x.com' });
  await sb2.flushEnrichSaves();
  const uens = sb2.getBuffer().map(r => r.uen);
  check('no duplicate uen after a re-enrich during an outage',
        uens.length === new Set(uens).size, JSON.stringify(uens));
}

// ── F10 + F12: the run loop's reporting and circuit breaker ──────────────
// startEnrich touches too much DOM to run directly, so the two behaviours are
// asserted against its source. Blunt, but it tests the shipping file.
function testRunLoop() {
  console.log('\nF10/F12 — run loop reports honestly and stops a doomed run');

  const src = extractFunction(HTML, 'startEnrich');

  check('success is counted, not assumed from the loop length',
        /succeeded\+\+/.test(src) && /let succeeded = 0/.test(src));
  check('the completion banner reports successes, not rows attempted',
        /\$\{succeeded\} companies enriched/.test(src) &&
        !/\$\{selRows\.length\} companies enriched/.test(src),
        'banner still uses selRows.length');
  check('failures are named in the banner when there are any',
        /if \(failed\)\s+parts\.push/.test(src));
  check('unsaved results are named in the banner',
        /unsavedEnrichCount\(\)/.test(src) && /not yet saved to the database/.test(src));
  check('a failure streak stops the run',
        /FAILURE_STREAK_LIMIT/.test(src) && /consecutiveFailures >= FAILURE_STREAK_LIMIT/.test(src));
  check('the streak resets after any success',
        /consecutiveFailures = 0/.test(src));
  check('work already done is flushed before stopping',
        /await flushEnrichSaves\(\);[\s\S]{0,400}Stopped after/.test(src));
  check('the actual error reaches the screen, not just the console',
        /Last error: \$\{esc\(lastError\)\}/.test(src));
  check('the Gemini quota message also reports successes',
        !/\$\{i\} of \$\{selRows\.length\} enriched/.test(src));
}

// ── F14: approve must not report success when it wrote nothing ───────────
function testApproveReporting() {
  console.log('\nF14 — an UPDATE that matched no row is not a success');

  const SAVE = fs.readFileSync(path.join(ROOT, 'netlify/functions/enrich-save.js'), 'utf8');
  const sb = { module: { exports: {} }, console, Number, Math };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(extractFunction(SAVE, 'countAffected') + '\nmodule.exports = { countAffected };', sb);
  const { countAffected } = sb.module.exports;

  const res = n => ({ response: { result: { affected_row_count: n } } });
  check('counts rows a pipeline actually changed',
        countAffected([res(1), res(1)]) === 2, String(countAffected([res(1), res(1)])));
  check('a zero-row UPDATE is counted as zero',
        countAffected([res(0)]) === 0);
  check('a missing row count does not crash or inflate',
        countAffected([{}, { response: {} }]) === 0);

  // The handler must turn that into a `missing` count the client can act on.
  check('handler reports updated/missing for approve and exported',
        /action === 'approve' \|\| action === 'exported'/.test(SAVE) &&
        /body\.missing = valid\.length - updated/.test(SAVE));
  check('handler does not report row counts for save (an upsert always writes)',
        !/body\.missing[\s\S]{0,80}action === 'save'/.test(SAVE));

  const approvalSrc = extractFunction(HTML, 'persistApproval');
  check('client treats a missing row as a failure, not a success',
        /j\.missing > 0/.test(approvalSrc) && /throw new Error/.test(approvalSrc));
  check('client shows the reason rather than a vague maybe',
        /Could not save approval — \$\{e\.message\}/.test(approvalSrc));
}

async function main() {
  await testBuffer();
  testRunLoop();
  testApproveReporting();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main();
