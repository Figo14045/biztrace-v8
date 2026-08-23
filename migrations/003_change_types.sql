-- ══════════════════════════════════════════════════════════════════════════
-- BizTrace — migration 003: widen the change_type taxonomy
--
-- Run AFTER 001. It rebuilds company_changes, so 001 must have created it.
--
-- ── Why ──────────────────────────────────────────────────────────────────
-- 001 hard-coded four change types into a CHECK constraint. Measuring the
-- real April→August diff showed that four is not enough, and — more to the
-- point — that the taxonomy is going to keep moving as we learn what the
-- sales team actually acts on. Two new types earned their place immediately:
--
--   GAZETTED   7,935 companies hit "Gazetted To Be Struck Off". That is
--              ACRA's public warning, not the strike-off. The company is
--              still contactable but on a clock — and 778 of the 7,935
--              recovered to Live, so folding it into STRUCK_OFF would have
--              written off live leads.
--
--   REVIVED    1,479 companies came back to a live status (Cancelled → Live,
--              Struck Off → Live Company, and similar). An existing business
--              that just restarted is a high-intent lead, and inside a
--              generic STATUS_CHANGED bucket it is unfindable.
--
-- ── The design change ────────────────────────────────────────────────────
-- Rather than swap four hard-coded values for six, the CHECK constraint is
-- dropped entirely. Altering a CHECK in SQLite means rebuilding the table —
-- which is exactly what this migration is having to do. Paying that cost
-- every time the taxonomy learns something is the wrong trade.
--
-- Validation moves to scripts/diff-acra.js, which is the only writer to this
-- table and already holds the change types as a documented constant. A single
-- writer validating its own vocabulary gives the same protection as the
-- CHECK, and lets a new type ship without touching the schema.
--
-- The change types as of this migration:
--     NEW_REGISTERED  STRUCK_OFF  GAZETTED  REVIVED
--     STATUS_CHANGED  ADDRESS_CHANGED
--
-- ── Safety ───────────────────────────────────────────────────────────────
-- Rename-copy-drop rather than drop-and-recreate, so this is non-destructive
-- even if the table already holds rows. At the time of writing it is empty —
-- no diff has run yet — so the copy is a no-op.
-- ══════════════════════════════════════════════════════════════════════════


-- Indexes stay attached to the table through a RENAME, keeping their original
-- names, so they must be dropped before those names can be reused.
DROP INDEX IF EXISTS idx_changes_dedupe;
DROP INDEX IF EXISTS idx_changes_uen;
DROP INDEX IF EXISTS idx_changes_month_type;

ALTER TABLE company_changes RENAME TO company_changes_old;

CREATE TABLE company_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uen           TEXT NOT NULL,
  change_month  TEXT NOT NULL,
  change_type   TEXT NOT NULL,          -- vocabulary owned by scripts/diff-acra.js
  field         TEXT NOT NULL DEFAULT '',
  old_value     TEXT,
  new_value     TEXT,
  detected_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO company_changes (id, uen, change_month, change_type, field, old_value, new_value, detected_at)
  SELECT id, uen, change_month, change_type, field, old_value, new_value, detected_at
    FROM company_changes_old;

DROP TABLE company_changes_old;

CREATE UNIQUE INDEX idx_changes_dedupe
  ON company_changes(uen, change_month, change_type, field);
CREATE INDEX idx_changes_uen
  ON company_changes(uen);
CREATE INDEX idx_changes_month_type
  ON company_changes(change_month, change_type);
