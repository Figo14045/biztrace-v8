// A badge must mean what it says.
//
// ADDRESS_CHANGED drives a "Moved" badge the sales team acts on. The diff
// compared raw strings, so a field going from ACRA's 'na' placeholder to a
// real value counted as a move. Measured between the August and September
// releases over 482,118 companies: 6,552 address differences, of which 322
// were 'na' -> value and 311 value -> 'na'. 9.6% of Moved badges would have
// been companies that never moved.
//
// Run: node scripts/test-change-detection.js

const path = require('path');
const { hasValue, isRealFieldChange, classifyStatusChange } =
  require(path.join(__dirname, 'lib', 'acra.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nhasValue');
check("'na' is not a value", !hasValue('na'));
check("'NA' is not a value either (case)", !hasValue('NA'));
check("' na ' padded is not a value", !hasValue(' na '));
check('an empty string is not a value', !hasValue(''));
check('null is not a value', !hasValue(null));
check('undefined is not a value', !hasValue(undefined));
check('a real unit number is a value', hasValue('04'));
check("'0' is a value (falsy in JS, real in data)", hasValue('0'));
check("a building called 'NANYANG' is a value", hasValue('NANYANG'));

console.log('\nisRealFieldChange');
check('a genuine move is a change', isRealFieldChange('10 ANSON RD', '5 SHENTON WAY'));
check("a backfill ('na' -> value) is NOT a move", !isRealFieldChange('na', '04'));
check("data removed (value -> 'na') is NOT a move", !isRealFieldChange('04', 'na'));
check("'' -> 'na' is not a move", !isRealFieldChange('', 'na'));
check('identical values are not a change', !isRealFieldChange('04', '04'));
check('whitespace-only difference is not a change', !isRealFieldChange('04', ' 04 '));
check('a real unit change is still caught', isRealFieldChange('04', '05'));

// The exact case from the real data that prompted this.
console.log('\nthe measured case (company 196600149M)');
const backfill = [['level_no','na','04'], ['unit_no','na','103P'], ['building_name','na','GERMAN CENTRE']];
check('none of its three backfilled fields count as a move',
      backfill.every(([, b, a]) => !isRealFieldChange(b, a)));
check('...but if it later moved floor, that does count',
      isRealFieldChange('04', '09'));

// Status classification is separate and must be untouched by this change.
console.log('\nstatus changes still work');
check('live -> struck off is still classified',
      !!classifyStatusChange('Live Company', 'Struck Off'));
check('no change is not classified', !classifyStatusChange('Live Company', 'Live Company'));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
