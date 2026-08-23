-- ══════════════════════════════════════════════════════════════════════════
-- BizTrace — Stage 3, migration 001: month-over-month change tracking
--
-- SCHEMA ONLY. This migration loads no ACRA data and rewrites no existing
-- row. It is safe to run against the live database.
--
-- What it creates:
--   data_versions    — which ACRA monthly release is currently loaded
--   company_changes  — the changelog: one row per (uen, month, type, field)
--   companies.change_status / change_month — denormalised badge columns
--
-- Why the badge columns are denormalised onto `companies` rather than read
-- through a join: the page query already selects from companies, and joining
-- 2M rows against a changelog to render a badge is exactly the shape that
-- caused the earlier enriched-filter timeout. Two extra columns cost nothing
-- (SQLite ADD COLUMN is a metadata-only operation, no row rewrite) and keep
-- the hot path join-free.
-- ══════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- 1. data_versions — the record of which ACRA release is loaded
-- ──────────────────────────────────────────────────────────────────────────
-- This is what makes the "New Registered clears after one month" rule work
-- without a monthly wipe of 2M rows. A badge is shown when a company's
-- change_month equals (SELECT MAX(month) FROM data_versions). Older change
-- months simply stop matching, so they stop rendering — no UPDATE needed.

CREATE TABLE IF NOT EXISTS data_versions (
  month             TEXT PRIMARY KEY,   -- 'YYYY-MM' of the ACRA release
  loaded_at         TEXT NOT NULL,      -- when we ingested it
  source            TEXT,               -- where the files came from
  companies_total   INTEGER,            -- row count after the load
  rows_inserted     INTEGER DEFAULT 0,
  rows_updated      INTEGER DEFAULT 0,
  changes_recorded  INTEGER DEFAULT 0,
  notes             TEXT
);

-- Seed with the release already sitting in Turso. Verified rather than
-- assumed: the local ACRA folder has exactly 2,080,623 data rows across its
-- 27 CSVs — matching the live table to the row — and its newest
-- registration_incorporation_date is 2026-03-31, which is the April release.
INSERT OR IGNORE INTO data_versions
  (month, loaded_at, source, companies_total, notes)
VALUES
  ('2026-04',
   datetime('now'),
   'data.gov.sg — ACRA Information on Corporate Entities (27 CSVs)',
   2080623,
   'Baseline. Loaded before change tracking existed, so there are deliberately no company_changes rows for this month.');


-- ──────────────────────────────────────────────────────────────────────────
-- 2. company_changes — the changelog
-- ──────────────────────────────────────────────────────────────────────────
-- One row per (uen, month, change_type, field). Field-level granularity is
-- what lets you ask "every company that moved out of Raffles Place since
-- April" later, instead of only "something changed".
--
-- NEW_REGISTERED has no before/after — a company either appeared in the new
-- release or it didn't. Those rows carry field = '' and old_value = NULL.
--
-- Sizing: this table holds only actual changes, not a monthly snapshot of
-- 2M rows. Even a four-month first diff should land in the low hundreds of
-- thousands of rows, which is why this design fits the 9GB budget where
-- monthly snapshots (~1.3GB each) do not.

CREATE TABLE IF NOT EXISTS company_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uen           TEXT NOT NULL,
  change_month  TEXT NOT NULL,          -- the release that introduced the change
  change_type   TEXT NOT NULL
                CHECK (change_type IN ('NEW_REGISTERED',
                                       'STRUCK_OFF',
                                       'STATUS_CHANGED',
                                       'ADDRESS_CHANGED')),
  field         TEXT NOT NULL DEFAULT '',  -- '' for NEW_REGISTERED
  old_value     TEXT,
  new_value     TEXT,
  detected_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Makes the diff script re-runnable. If a run dies halfway you can just run
-- it again: INSERT OR IGNORE against this index means already-recorded
-- changes are skipped rather than duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_changes_dedupe
  ON company_changes(uen, change_month, change_type, field);

-- "What changed for this company?" — the per-row history lookup.
CREATE INDEX IF NOT EXISTS idx_changes_uen
  ON company_changes(uen);

-- "Everything struck off in August" — drives the change views and counts.
CREATE INDEX IF NOT EXISTS idx_changes_month_type
  ON company_changes(change_month, change_type);


-- ──────────────────────────────────────────────────────────────────────────
-- 3. companies — the badge columns
-- ──────────────────────────────────────────────────────────────────────────
-- change_status holds the HIGHEST-PRIORITY change for this company in
-- change_month. Priority order, highest first:
--
--     NEW_REGISTERED  >  STRUCK_OFF  >  STATUS_CHANGED  >  ADDRESS_CHANGED
--
-- The full set for the tooltip comes from company_changes, queried only for
-- the ~50 rows actually on screen — never joined across the whole table.
--
-- These two ALTERs are the only statements here that touch `companies`, and
-- SQLite implements ADD COLUMN by updating the table header, not by
-- rewriting 2M rows. They are effectively instant.
--
-- NOTE: unlike everything above, ALTER TABLE ADD COLUMN has no IF NOT EXISTS
-- form. scripts/migrate.js treats "duplicate column name" as already-applied
-- and continues, so re-running the migration is still safe.

ALTER TABLE companies ADD COLUMN change_status TEXT;
ALTER TABLE companies ADD COLUMN change_month TEXT;

-- Partial index: change_status is NULL for the overwhelming majority of the
-- 2M rows, and a full index would carry all of them for nothing. Restricting
-- it to changed rows keeps the index roughly the size of one month's diff.
CREATE INDEX IF NOT EXISTS idx_companies_change
  ON companies(change_month, change_status)
  WHERE change_status IS NOT NULL;
