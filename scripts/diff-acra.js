#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// Compare two ACRA monthly releases and produce the change set.
//
//   node scripts/diff-acra.js --old <dir> --new <dir> --month 2026-08
//
// Writes NOTHING to Turso. Its whole job is to turn two folders of CSVs into
// three files on disk, which a separate loader then applies. Keeping the two
// apart means the expensive part can be re-run, inspected, and diffed against
// expectations before a single row is written to the database.
//
// Output (default ./data/diff-<month>/):
//
//   changes.jsonl   one JSON object per changelog row
//                   { uen, change_month, change_type, field, old_value, new_value }
//
//   upserts.jsonl   full 53-column row for every company that is new or
//                   changed in ANY column — this is what refreshes companies.
//                   Measured at 436,283 rows for April→August, vs 2,110,094
//                   for a full reload: a 79% saving.
//
//   badges.jsonl    { uen, change_status, change_month } — the highest
//                   priority change per company, for the denormalised
//                   badge columns.
//
//   summary.json    counts, timings, and any warnings.
//
// Flags:
//   --out <dir>     override the output directory
//   --report-only   compute and print the summary, write no files
//   --limit <n>     stop after n rows of the new release (for a quick trial)
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
  ADDRESS_FIELDS, STATUS_FIELD, ACRA_COLUMNS,
  CHANGE_TYPES, BADGE_PRIORITY,
  isKnown, classifyStatusChange, readRelease,
} = require('./lib/acra');

const SEP = '\x1f';
const CHANGE_TYPE_SET = new Set(CHANGE_TYPES);
const BADGE_RANK = new Map(BADGE_PRIORITY.map((t, i) => [t, i]));

// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { reportOnly: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--old')          args.old = argv[++i];
    else if (a === '--new')     args.new = argv[++i];
    else if (a === '--month')   args.month = argv[++i];
    else if (a === '--out')     args.out = argv[++i];
    else if (a === '--limit')   args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--report-only') args.reportOnly = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

// A buffered JSONL writer. Writing 436k lines one fs.appendFileSync at a time
// would dominate the runtime; batching keeps I/O off the critical path.
function jsonlWriter(filePath, enabled) {
  if (!enabled) return { write() {}, close() {}, count: 0 };

  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  let buffer = [];
  let count = 0;

  return {
    write(obj) {
      buffer.push(JSON.stringify(obj));
      count++;
      if (buffer.length >= 2000) {
        stream.write(buffer.join('\n') + '\n');
        buffer = [];
      }
    },
    get count() { return count; },
    close() {
      return new Promise(resolve => {
        if (buffer.length) stream.write(buffer.join('\n') + '\n');
        stream.end(resolve);
      });
    },
  };
}

function fmt(n) { return n.toLocaleString('en-US'); }

// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  for (const required of ['old', 'new', 'month']) {
    if (!args[required]) {
      console.error('Usage: node scripts/diff-acra.js --old <dir> --new <dir> --month YYYY-MM [--out <dir>] [--report-only]');
      process.exit(1);
    }
  }
  if (!/^\d{4}-\d{2}$/.test(args.month)) {
    console.error(`--month must be YYYY-MM, got: ${args.month}`);
    process.exit(1);
  }

  const outDir = args.out || path.join(process.cwd(), 'data', `diff-${args.month}`);
  const writeFiles = !args.reportOnly;
  if (writeFiles) fs.mkdirSync(outDir, { recursive: true });

  const started = Date.now();

  console.log('');
  console.log(`Old release : ${args.old}`);
  console.log(`New release : ${args.new}`);
  console.log(`Month label : ${args.month}`);
  console.log(`Output      : ${writeFiles ? outDir : '(report only, nothing written)'}`);
  console.log('');

  // ── Pass 1: index the old release ───────────────────────────────────────
  // uen → "<status>\x1f<addr…>\x1f<fullRowHash>"
  //
  // Only the watched fields plus a whole-row fingerprint are kept. Holding
  // all 53 columns for 2.08M rows would need several GB; this needs a few
  // hundred MB, and the fingerprint is enough to decide whether the loader
  // must refresh the row.

  process.stdout.write('Reading old release... ');
  const previous = new Map();

  await readRelease(args.old, (values, index) => {
    const watched = [values[index[STATUS_FIELD]]];
    for (const f of ADDRESS_FIELDS) watched.push(values[index[f]]);
    watched.push(hashRow(values));
    previous.set(values[index.uen], watched.join(SEP));
  });

  console.log(`${fmt(previous.size)} rows`);

  // ── Pass 2: stream the new release and classify ─────────────────────────

  process.stdout.write('Reading new release... ');

  const changes = jsonlWriter(path.join(outDir, 'changes.jsonl'), writeFiles);
  const upserts = jsonlWriter(path.join(outDir, 'upserts.jsonl'), writeFiles);
  const badges  = jsonlWriter(path.join(outDir, 'badges.jsonl'),  writeFiles);

  const counts = Object.fromEntries(CHANGE_TYPES.map(t => [t, 0]));
  const stats = {
    newRows: 0, changedAnyColumn: 0, identical: 0,
    changelogRows: 0, companiesBadged: 0,
  };
  const unknownStatuses = new Map();
  const seen = new Set();

  await readRelease(args.new, (values, index, meta) => {
    if (args.limit && seen.size >= args.limit) return;

    const uen = values[index.uen];
    seen.add(uen);

    const status = values[index[STATUS_FIELD]];
    if (!isKnown(status)) {
      unknownStatuses.set(status, (unknownStatuses.get(status) || 0) + 1);
    }

    const prev = previous.get(uen);
    const rowChanges = [];

    if (prev === undefined) {
      // Not in the old release at all. Detected by UEN set difference rather
      // than by a date column, so it survives ACRA backfilling old records.
      rowChanges.push({ type: 'NEW_REGISTERED', field: '', old: null, new: null });
      stats.newRows++;
      writeUpsert(upserts, values, index, meta);
    } else {
      const parts = prev.split(SEP);
      const prevStatus = parts[0];
      const prevAddress = parts.slice(1, 1 + ADDRESS_FIELDS.length);
      const prevHash = parts[1 + ADDRESS_FIELDS.length];

      const statusType = classifyStatusChange(prevStatus, status);
      if (statusType) {
        rowChanges.push({
          type: statusType, field: STATUS_FIELD,
          old: prevStatus, new: status,
        });
      }

      ADDRESS_FIELDS.forEach((f, i) => {
        const before = prevAddress[i];
        const after = values[index[f]];
        if (before !== after) {
          rowChanges.push({ type: 'ADDRESS_CHANGED', field: f, old: before, new: after });
        }
      });

      // The loader refreshes any row that differs in ANY of the 53 columns,
      // not just the watched ones — otherwise companies silently drifts away
      // from what ACRA published. prevHash came back out of a joined string,
      // so compare as strings rather than relying on coercion.
      if (prevHash !== String(hashRow(values))) {
        stats.changedAnyColumn++;
        writeUpsert(upserts, values, index, meta);
      } else {
        stats.identical++;
      }
    }

    if (!rowChanges.length) return;

    let best = null;
    for (const c of rowChanges) {
      if (!CHANGE_TYPE_SET.has(c.type)) {
        throw new Error(`Internal error: unknown change type "${c.type}" for UEN ${uen}`);
      }
      counts[c.type]++;
      stats.changelogRows++;
      changes.write({
        uen,
        change_month: args.month,
        change_type: c.type,
        field: c.field,
        old_value: c.old,
        new_value: c.new,
      });
      if (best === null || BADGE_RANK.get(c.type) < BADGE_RANK.get(best)) best = c.type;
    }

    stats.companiesBadged++;
    badges.write({ uen, change_status: best, change_month: args.month });
  });

  await Promise.all([changes.close(), upserts.close(), badges.close()]);

  // A UEN in the old release but not the new one. Two of them April→August,
  // so this is a rounding error rather than a category — but silence would be
  // the wrong default if a future month purges records in bulk.
  const disappeared = [];
  for (const uen of previous.keys()) {
    if (!seen.has(uen)) disappeared.push(uen);
    if (disappeared.length > 50) break;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`${fmt(seen.size)} rows`);
  console.log('');
  console.log('Changes by type');
  console.log('───────────────────────────────────────────────');
  for (const t of BADGE_PRIORITY) {
    console.log(`  ${t.padEnd(18)} ${fmt(counts[t]).padStart(10)}`);
  }
  console.log('');
  console.log('Rows');
  console.log('───────────────────────────────────────────────');
  console.log(`  changelog rows     ${fmt(stats.changelogRows).padStart(10)}`);
  console.log(`  companies badged   ${fmt(stats.companiesBadged).padStart(10)}`);
  console.log(`  upserts (new)      ${fmt(stats.newRows).padStart(10)}`);
  console.log(`  upserts (changed)  ${fmt(stats.changedAnyColumn).padStart(10)}`);
  console.log(`  untouched          ${fmt(stats.identical).padStart(10)}`);
  console.log(`  disappeared        ${fmt(disappeared.length).padStart(10)}${disappeared.length > 50 ? '+' : ''}`);
  console.log('');

  if (unknownStatuses.size) {
    console.log('  ⚠ UNRECOGNISED STATUS VALUES — these were classified as');
    console.log('    STATUS_CHANGED by default. Add them to LIVE_STATUSES or');
    console.log('    DEAD_STATUSES in scripts/lib/acra.js if that is wrong:');
    for (const [s, n] of unknownStatuses) console.log(`      ${fmt(n).padStart(8)}  ${s}`);
    console.log('');
  }

  console.log(`Completed in ${elapsed}s`);

  if (writeFiles) {
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      month: args.month,
      old_release: args.old,
      new_release: args.new,
      generated_at: new Date().toISOString(),
      elapsed_seconds: Number(elapsed),
      old_rows: previous.size,
      new_rows: seen.size,
      counts, stats,
      unknown_statuses: Object.fromEntries(unknownStatuses),
      disappeared_sample: disappeared,
    }, null, 2));
    console.log(`Written to ${outDir}`);
  } else {
    console.log('Report only — no files written.');
  }
  console.log('');
}

// Full-row fingerprint: 32-bit FNV-1a, folded field by field.
//
// Two deliberate choices here, both about the 2.1M-rows-twice budget:
//
// 1. No join(). Building a ~300-character string per row just to hash it
//    means 2.1M throwaway allocations per release. Folding each field
//    straight into the accumulator does the same work without them, with a
//    separator byte mixed in between fields so that ["ab","c"] and ["a","bc"]
//    still hash differently.
//
// 2. 32 bits is enough, which is less obvious than it looks. The birthday
//    intuition says 2.1M values in a 4.3B space should collide constantly,
//    and it would — if we compared every row against every other row. We
//    don't. Each hash is only ever compared against the hash of the SAME UEN
//    in the other release, so these are 2.1M independent one-to-one
//    comparisons, not a pool. The chance a genuinely changed row is missed is
//    2^-32 each, about 0.0005 rows across the whole release.
//
//    A miss would mean one company's non-watched columns going stale for a
//    month. Watched changes are compared by value, never by hash, so status
//    and address changes cannot be missed this way at all.
function hashRow(values) {
  let h = 0x811c9dc5;
  for (let f = 0; f < values.length; f++) {
    const v = values[f];
    for (let i = 0; i < v.length; i++) {
      h = Math.imul(h ^ v.charCodeAt(i), 0x01000193);
    }
    h = Math.imul(h ^ 0x1f, 0x01000193);
  }
  return h >>> 0;
}

function writeUpsert(writer, values, index, meta) {
  const row = {};
  for (const col of ACRA_COLUMNS) {
    const i = index[col];
    row[col] = i === undefined ? 'na' : values[i];
  }
  // companies.source_file records which of the 27 alphabet CSVs a row came
  // from. Carried through here so a newly registered company gets a real
  // value rather than a NULL that nothing would ever backfill.
  row.source_file = meta ? meta.file : 'na';
  writer.write(row);
}

// Set exitCode rather than calling process.exit(). On Windows, exiting while
// the HTTP client still has sockets closing trips an assertion inside libuv
// (`!(handle->flags & UV_HANDLE_CLOSING)`), which buries the real error under
// a crash dump. Letting Node unwind on its own avoids it.
main().catch(err => {
  console.error('');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
