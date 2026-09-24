// Exactly one view may be on screen at a time.
//
// The bug: Enriched Records is not a view of its own — it is the home table
// with the enrichment filter pinned — so setView() returns early and calls
// showEnrichedRecords() instead. That function showed #layout but never hid
// #spendView, because the hiding lived in the part of setView it had already
// skipped. Going Spend -> Enriched Records rendered both, one over the other.
//
// It only showed up on that one transition, which is why a spot check missed
// it. This walks every ordered pair of views and asserts the invariant after
// each move.
//
// Run: node scripts/test-view-switching.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const start = src.search(re);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// A DOM just real enough: elements that remember `hidden`.
const els = {};
const el = id => (els[id] = els[id] || { id, hidden: false });
['layout', 'spendView'].forEach(el);

const sb = { console, Object, document: { getElementById: id => els[id] || null } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(
  extractFunction(HTML, 'showOnlyView') + '\n' +
  HTML.match(/const VIEW_ELEMENTS = \{[^}]*\};/)[0], sb);

const VIEWS = ['home', 'spend', 'enriched'];
const expectedVisible = v => (v === 'spend' ? 'spendView' : 'layout');

// Every ordered pair, including staying put.
for (const from of VIEWS) {
  for (const to of VIEWS) {
    sb.showOnlyView(from);
    sb.showOnlyView(to);
    const visible = Object.values(els).filter(e => !e.hidden).map(e => e.id);
    check(`${from} → ${to}: exactly one view visible`,
          visible.length === 1, `visible: ${visible.join(' + ') || 'none'}`);
    check(`${from} → ${to}: the right one`,
          visible[0] === expectedVisible(to), `got ${visible[0]}`);
  }
}

// The two entry points must both go through the single decision point, or the
// next view added reintroduces this.
const setViewSrc = extractFunction(HTML, 'setView');
const enrichedSrc = extractFunction(HTML, 'showEnrichedRecords');
check('setView delegates to showOnlyView', /showOnlyView\(v\)/.test(setViewSrc));
check('showEnrichedRecords delegates too', /showOnlyView\('enriched'\)/.test(enrichedSrc));
check('no view toggles .hidden directly any more',
      !/getElementById\('(layout|spendView)'\)\.hidden\s*=/.test(HTML),
      'a direct assignment bypasses the single decision point');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
