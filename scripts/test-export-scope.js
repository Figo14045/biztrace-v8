// Regression test for the page-scoping bug class.
//
// Three functions decide "which rows am I acting on": the enrichment run, the
// enrichment panel's export, and the selection counter on the button. Each one
// was written at a different time, and two of them independently reached for
// `allResults` — which holds only the page currently on screen. That produced:
//
//   - 1,609 companies selected, 9 enriched   (the last page had 9 rows)
//   - 500 enriched, 100 rows in the CSV      (the page on screen had 100)
//
// The rule this test defends: anything acting on "the selection" must read
// selectedRowList(), never allResults. Both are page-independent facts, so the
// test builds a 500-row selection spread over five pages, points allResults at
// one page, and checks the scope each function would use.
//
// No browser and no dependencies: the functions under test are pulled out of
// index.html and evaluated with the handful of globals they touch. That is
// blunt, but it tests the shipping source rather than a copy of it, so it
// cannot drift out of date the way a transcription would.
//
// Run: node scripts/test-export-scope.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Pull one top-level function out of index.html by name, brace-matching from
// its opening `{` so nested braces don't end the capture early.
function extractFunction(name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = HTML.search(re);
  if (start === -1) throw new Error(`function ${name} not found in index.html`);
  let i = HTML.indexOf('{', start), depth = 0;
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return HTML.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function makeRows(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    uen: `U${String(offset + i).padStart(5, '0')}`,
    entity_name: `COMPANY ${offset + i} PTE LTD`,
  }));
}

function main() {
  // 500 selected across five pages of 100; allResults holds only page 5, which
  // is what the browser would have in memory after paging there.
  const all = makeRows(500);
  const pageOnScreen = all.slice(400);

  const enrichData = {};
  for (const r of all) enrichData[r.uen] = { badge: 'VERIFIED', email: `x@${r.uen}.com` };
  // Two rows queued but never looked up — placeholders startEnrich seeds.
  enrichData['U00498'] = { approval: 'queued', badge: null };
  enrichData['U00499'] = { approval: 'queued', badge: null };

  const sandbox = {
    console,
    selected: new Set(all.map(r => r.uen)),
    selectedRows: new Map(all.map(r => [r.uen, r])),
    allResults: pageOnScreen,
    enrichData,
    exported: [],
    downloaded: null,
    showToast: () => {},
    downloadCSV: (rows, filename) => { sandbox.downloaded = { rows, filename }; },
    markExported: async uens => { sandbox.exported = uens; },
    Date, Object, Array, String, Number, Boolean, JSON, Math, Set, Map,
  };
  sandbox.globalThis = sandbox;

  const src = [
    'selectRow', 'deselectRow', 'clearSelection', 'selectedRowList',
    'isEnrichmentAttempted', 'exportEnrichedCSV',
  ].map(extractFunction).join('\n\n');

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // 1. The selection itself spans pages, independent of what is on screen.
  check('selectedRowList sees all 500, not just the page on screen',
        sandbox.selectedRowList().length === 500,
        `got ${sandbox.selectedRowList().length}`);
  check('allResults really is one page (the trap being tested)',
        sandbox.allResults.length === 100, `got ${sandbox.allResults.length}`);

  // 2. The bug as reported: 500 enriched, 100 rows in the file.
  return sandbox.exportEnrichedCSV().then(() => {
    const out = sandbox.downloaded;
    check('export produced a file', !!out, 'downloadCSV was never called');
    check('CSV has 498 rows, not 100',
          out && out.rows.length === 498, `got ${out ? out.rows.length : 'none'}`);
    check('queued-but-not-looked-up rows are excluded',
          out && !out.rows.some(r => r.uen === 'U00498' || r.uen === 'U00499'),
          'a placeholder row was exported as a contact');
    check('rows come from the whole selection, not only page 5',
          out && out.rows.some(r => r.uen === 'U00000'),
          'page-1 rows are missing from the export');

    // 3. Exported rows are stamped, so they stop coming back in the next
    //    "not yet exported" export — the duplicate-rows problem.
    check('every exported row is marked exported',
          sandbox.exported.length === 498, `marked ${sandbox.exported.length}`);

    // 4. The fallback: with nothing selected, the button still exports the
    //    visible page rather than silently doing nothing.
    sandbox.clearSelection();
    sandbox.downloaded = null;
    sandbox.exported = [];
    return sandbox.exportEnrichedCSV().then(() => {
      check('with no selection, falls back to the visible page',
            sandbox.downloaded && sandbox.downloaded.rows.length === 98,
            `got ${sandbox.downloaded ? sandbox.downloaded.rows.length : 'none'}`);

      console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
      process.exitCode = failures ? 1 : 0;
    });
  });
}

main();
