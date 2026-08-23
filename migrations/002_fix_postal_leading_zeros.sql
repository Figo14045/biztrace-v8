-- ══════════════════════════════════════════════════════════════════════════
-- BizTrace — migration 002: repair postal codes that lost a leading zero
--
-- THIS IS A LIVE BUG FIX, not part of Stage 3. It is separate from 001 on
-- purpose so it can ship immediately rather than waiting for the change
-- tracking pipeline.
--
-- ── What is wrong ────────────────────────────────────────────────────────
-- Singapore postal codes are six digits, and roughly one in twelve begins
-- with a zero. In the April ACRA release that Turso was loaded from, 164,477
-- postal codes are stored as FIVE digits — the leading zero was stripped
-- somewhere upstream (the classic spreadsheet "treat it as a number" bug).
--
-- Measured, not assumed. Across the two local ACRA releases:
--
--     postal_code length     April        August
--     ------------------  ----------  ----------
--     5 digits               164,477           0
--     6 digits             1,865,220   2,059,168
--
-- and 161,142 of the April five-digit values match an August six-digit value
-- exactly once you prepend the zero. e.g. UEN 200302330D is '79903' in April
-- and '079903' in August.
--
-- ── Why it matters today ─────────────────────────────────────────────────
-- query.js filters postal code with an EXACT match (postal_code = ?). A
-- salesperson searching 079903 — the correct, printed form — matches nothing
-- for any of these companies. They are invisible to postal search, and to the
-- smart address parser, which routes postal codes to the same field. That is
-- around 8% of the database silently missing from address-based targeting.
--
-- ── Scope check ──────────────────────────────────────────────────────────
-- Only postal_code is affected. block, level_no and unit_no are also
-- zero-padded in this dataset and were checked column by column across both
-- releases: their leading-zero counts and length distributions are unchanged
-- between April and August, so they were not touched by whatever stripped
-- the postal codes.
--
-- ── Safety ───────────────────────────────────────────────────────────────
-- The WHERE clause is deliberately narrow: exactly five characters, every one
-- of them a digit. A five-digit numeric postal code is always a six-digit
-- code missing its leading zero — there is no valid five-digit Singapore
-- postal code — so prepending '0' is a total, unambiguous repair. Rows
-- holding 'na', four-digit values, or anything non-numeric are not matched.
--
-- Idempotent: after it runs, no row satisfies the WHERE clause any more, so
-- running it twice changes nothing.
--
-- NOTE: this writes to `companies`, which the application itself never does
-- (enrich-save.js is scoped to `enrichments` precisely so the authoritative
-- ACRA table is never touched by app code). That rule is about the app. A
-- migration run deliberately from your machine is the intended exception.
--
-- ── The same bug, one length down ────────────────────────────────────────
-- This dataset also carries the older FOUR-digit postal sector codes —
-- 45,678 of them in August, so four digits is a legitimate length here. And
-- 88 of those lost a leading zero in April in exactly the same way: '105' in
-- April is '0105' in August, '718' is '0718'.
--
-- So the rule is not "five digits" but "one zero short of a canonical
-- length", and the canonical lengths in this data are four and six. Both
-- cases are repaired below.
--
-- Lengths one and two are deliberately left alone. They appear identically
-- in both releases (5 and 31 values), so they are stable junk rather than a
-- truncation pattern, and padding them would be a guess rather than a repair.
--
-- Both statements remain idempotent, and safe to run even if the five-digit
-- statement was already applied on its own: once a row has been padded it no
-- longer matches its WHERE clause.
-- ══════════════════════════════════════════════════════════════════════════

-- 164,477 rows: five digits → six.
UPDATE companies
   SET postal_code = '0' || postal_code
 WHERE length(postal_code) = 5
   AND postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]';

-- 96 rows: three digits → four.
UPDATE companies
   SET postal_code = '0' || postal_code
 WHERE length(postal_code) = 3
   AND postal_code GLOB '[0-9][0-9][0-9]';
