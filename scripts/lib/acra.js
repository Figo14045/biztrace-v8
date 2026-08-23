// ══════════════════════════════════════════════════════════════════════════
// ACRA release reading, normalisation, and the change taxonomy.
//
// Shared by the diff and the loader so there is exactly one definition of
// "what a change is" and one definition of "what the data should look like".
// Zero dependencies.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ──────────────────────────────────────────────────────────────────────────
// The 53 columns of an ACRA release, in file order.
// `companies` in Turso is these plus source_file. has_auditor and
// full_address are computed in query.js, not stored.
// ──────────────────────────────────────────────────────────────────────────
const ACRA_COLUMNS = [
  'uen', 'issuance_agency_id', 'entity_name', 'entity_type_description',
  'business_constitution_description', 'company_type_description',
  'paf_constitution_description', 'entity_status_description',
  'registration_incorporation_date', 'uen_issue_date',
  'address_type', 'block', 'street_name', 'level_no', 'unit_no',
  'building_name', 'postal_code', 'other_address_line1', 'other_address_line2',
  'account_due_date', 'annual_return_date',
  'primary_ssic_code', 'primary_ssic_description', 'primary_user_described_activity',
  'secondary_ssic_code', 'secondary_ssic_description', 'secondary_user_described_activity',
  'no_of_officers',
  'former_entity_name1', 'former_entity_name2', 'former_entity_name3',
  'former_entity_name4', 'former_entity_name5', 'former_entity_name6',
  'former_entity_name7', 'former_entity_name8', 'former_entity_name9',
  'former_entity_name10', 'former_entity_name11', 'former_entity_name12',
  'former_entity_name13', 'former_entity_name14', 'former_entity_name15',
  'uen_of_audit_firm1', 'name_of_audit_firm1', 'uen_of_audit_firm2',
  'name_of_audit_firm2', 'uen_of_audit_firm3', 'name_of_audit_firm3',
  'uen_of_audit_firm4', 'name_of_audit_firm4', 'uen_of_audit_firm5',
  'name_of_audit_firm5',
];

// Address fields watched for ADDRESS_CHANGED.
const ADDRESS_FIELDS = [
  'block', 'street_name', 'level_no', 'unit_no', 'building_name', 'postal_code',
];

const STATUS_FIELD = 'entity_status_description';

// ──────────────────────────────────────────────────────────────────────────
// Change taxonomy
// ──────────────────────────────────────────────────────────────────────────
// The CHECK constraint that used to hold this list was dropped in migration
// 003. This constant is now the single source of truth, and the diff
// validates every row it emits against it.

const CHANGE_TYPES = Object.freeze([
  'NEW_REGISTERED',
  'STRUCK_OFF',
  'GAZETTED',
  'REVIVED',
  'STATUS_CHANGED',
  'ADDRESS_CHANGED',
]);

// Badge priority, highest first. A company that changed in several ways shows
// the highest-priority badge; the rest are listed in the tooltip, read from
// company_changes for the ~50 rows actually on screen.
//
// STRUCK_OFF sits at the top rather than NEW_REGISTERED (which is where the
// original Stage 3 sketch had it) for one reason: the cost of the two
// mistakes is not symmetric. Missing a new registration wastes an
// opportunity; missing a strike-off wastes a salesperson's afternoon on a
// company that no longer exists. Easy to swap — it is this array's order.
const BADGE_PRIORITY = Object.freeze([
  'STRUCK_OFF',
  'NEW_REGISTERED',
  'REVIVED',
  'GAZETTED',
  'STATUS_CHANGED',
  'ADDRESS_CHANGED',
]);

// ──────────────────────────────────────────────────────────────────────────
// Status classification
// ──────────────────────────────────────────────────────────────────────────
// Derived from the 36 distinct entity_status_description values actually
// present in the August 2026 release, not from guesswork. Counts in comments
// are from that release.
//
// Note that ACRA uses two different "alive" words: "Live Company" for
// incorporated companies and "Live" for sole proprietorships and
// partnerships. Both mean trading.

const LIVE_STATUSES = new Set([
  'Live Company',                                       // 463,488
  'Live',                                               // 155,418
  'Live (Receiver or Receiver and Manager appointed)',  //     106
]);

// Terminal states. The legal entity behind this UEN has ceased to exist.
//
// "Converted To LLP" and "Amalgamated" are included deliberately: the
// business may well continue, but it continues under a DIFFERENT UEN, and
// this UEN is finished. For lead purposes that is the same as dead.
const DEAD_STATUSES = new Set([
  'Struck Off',                                             // 517,376
  'Struck Off (Early Dissolution)',                         //      92
  'Struck Off (Early Dissolution - simplified winding up)', //      53
  'Terminated',                                             // 355,163
  'Cancelled',                                              // 302,731
  'Cancelled (Non-Renewal)',                                // 138,615
  'Ceased Registration',                                    // 110,191
  'Ceased Registration (Transferred to Singapore)',         //      12
  'Converted To LLP',                                       //   4,179
  'Amalgamated',                                            //   2,655
  'Registration expired and has not been renewed',          //   1,136
  'Removed (Applied To Be Revoked)',                        //     324
  'Removed (Dissolved)',                                    //     106
  'Revoked (Failed To Transfer Registration)',              //       2
  // Every "Dissolved - ..." variant is matched by prefix in isDead().
  'Dissolved',                                              //     265
]);

// In-between states: not trading normally, not finished either. A company in
// liquidation or under judicial management can still be contacted, and can
// still come back. These produce STATUS_CHANGED, never STRUCK_OFF.
//
//   Gazetted To Be Struck Off                     8,057  → its own GAZETTED type
//   In Liquidation - * (6 variants)               4,049
//   Cancellation In Progress                        773
//   Suspended                                        60
//   To Be Ceased                                     30
//   Under Judicial Management                        12

const GAZETTED_STATUS = 'Gazetted To Be Struck Off';

function isLive(status) {
  return LIVE_STATUSES.has(status);
}

function isDead(status) {
  return DEAD_STATUSES.has(status) || status.startsWith('Dissolved');
}

// Anything we have never seen before. New months can introduce new status
// values, and silently misclassifying one is exactly the sort of thing that
// goes unnoticed for months — so the diff reports these loudly instead.
function isKnown(status) {
  return status === 'na' ||
         isLive(status) ||
         isDead(status) ||
         status === GAZETTED_STATUS ||
         status.startsWith('In Liquidation') ||
         status === 'Cancellation In Progress' ||
         status === 'Suspended' ||
         status === 'To Be Ceased' ||
         status === 'Under Judicial Management';
}

// Which change type a status transition represents.
// Order matters: a Gazetted → Struck Off transition is a strike-off, not a
// gazette, and the dead test must therefore come first.
function classifyStatusChange(oldStatus, newStatus) {
  if (oldStatus === newStatus) return null;
  if (isDead(newStatus) && !isDead(oldStatus)) return 'STRUCK_OFF';
  if (isLive(newStatus) && !isLive(oldStatus)) return 'REVIVED';
  if (newStatus === GAZETTED_STATUS) return 'GAZETTED';
  return 'STATUS_CHANGED';
}

// ──────────────────────────────────────────────────────────────────────────
// Normalisation
// ──────────────────────────────────────────────────────────────────────────
// Singapore postal codes are six digits and about one in twelve starts with
// a zero. The April 2026 release has 164,477 of them stored as five digits —
// the leading zero stripped upstream, the classic spreadsheet-as-number bug.
// August has none.
//
// Without this, 161,142 companies would show up as ADDRESS_CHANGED when
// nothing about them moved: the repair would masquerade as a relocation and
// bury the 25,976 companies that actually did move.
//
// There is no valid five-digit Singapore postal code, so prepending the zero
// is a total repair rather than a guess. Applied to BOTH sides of the diff,
// and by the loader on the way into Turso.
//
// The same bug appears one length down. This dataset also carries the older
// four-digit postal sector codes (45,678 of them in August), and 88 of those
// lost a leading zero in April in exactly the same way — '105' in April is
// '0105' in August, '718' is '0718'. So the rule is not "five digits" but
// "one zero short of a canonical length", and the canonical lengths here are
// four and six.
//
// Lengths one and two are left alone: they appear identically in both
// releases (5 and 31 values respectively), so they are stable junk rather
// than a truncation pattern, and padding them would be a guess.

function normalisePostalCode(value) {
  const n = value.length;
  if ((n === 5 || n === 3) && /^[0-9]+$/.test(value)) return '0' + value;
  return value;
}

function normaliseRow(row, index) {
  const ip = index.postal_code;
  if (ip !== undefined && row[ip] !== undefined) {
    row[ip] = normalisePostalCode(row[ip]);
  }
  return row;
}

// ──────────────────────────────────────────────────────────────────────────
// CSV parsing
// ──────────────────────────────────────────────────────────────────────────
// A minimal RFC 4180 line parser. entity_name routinely contains commas and
// quotes, so splitting on ',' is not an option. Fields never contain raw
// newlines in this dataset (checked: line counts match row counts exactly),
// so a line-at-a-time reader is safe and much faster than buffering.

function parseCsvLine(line) {
  // Fast path. Measured on the August release, only ~6% of lines contain a
  // quote character at all — the rest are plain comma-separated values where
  // split() does the same job as the character walk below, but in native code
  // rather than a JS loop. Across 2.1M rows that difference is most of the
  // runtime, so the cheap check earns its place.
  if (line.indexOf('"') === -1) return line.split(',');

  const out = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { out.push(field); field = ''; continue; }
    field += ch;
  }

  out.push(field);
  return out;
}

// List the 27 CSVs of a release directory, sorted for stable ordering.
function releaseFiles(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`ACRA release directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .sort()
    .map(f => path.join(dir, f));

  if (!files.length) throw new Error(`No CSV files in: ${dir}`);
  return files;
}

// Stream one release, calling onRow(valuesArray, index, meta) for every data
// row. `index` maps column name → position, read from each file's own header
// rather than assumed, so a column reorder upstream cannot corrupt the diff.
// `meta.file` is the source CSV's basename, which `companies.source_file`
// records.
//
// onFile(filename, rowCount) is called as each file completes, for progress.
async function readRelease(dir, onRow, onFile) {
  for (const file of releaseFiles(dir)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let index = null;
    let count = 0;
    const meta = { file: path.basename(file) };

    for await (const line of rl) {
      if (!line) continue;

      if (index === null) {
        const header = parseCsvLine(line);
        index = {};
        header.forEach((name, i) => { index[name.trim()] = i; });

        for (const required of ['uen', STATUS_FIELD, ...ADDRESS_FIELDS]) {
          if (index[required] === undefined) {
            throw new Error(`${path.basename(file)}: missing expected column "${required}"`);
          }
        }
        continue;
      }

      const values = parseCsvLine(line);
      if (values.length <= index.uen) continue;

      onRow(normaliseRow(values, index), index, meta);
      count++;
    }

    if (onFile) onFile(path.basename(file), count);
  }
}

module.exports = {
  ACRA_COLUMNS, ADDRESS_FIELDS, STATUS_FIELD,
  CHANGE_TYPES, BADGE_PRIORITY,
  LIVE_STATUSES, DEAD_STATUSES, GAZETTED_STATUS,
  isLive, isDead, isKnown, classifyStatusChange,
  normalisePostalCode, normaliseRow,
  parseCsvLine, releaseFiles, readRelease,
};
